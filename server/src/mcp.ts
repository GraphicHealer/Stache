import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, sql } from './db';
import { areas, items, labels, mcpTokens, photos } from './db/schema';
import { breadcrumb } from './lib/breadcrumb';
import { recordEvent } from './lib/events';
import { photoUrl, thumbUrl } from './lib/photos';

const text = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

const pathOf = async (areaId: string) =>
  (await breadcrumb(areaId)).map((c) => c.name ?? 'unnamed').join(' › ');

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'stash', version: '0.1.0' });

  server.registerTool(
    'search_items',
    {
      description:
        'Search the home inventory by name, description, or barcode. Returns items with their location paths.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const rows = await sql<{ id: string; name: string | null; description: string | null; area_id: string; status: string }[]>`
        SELECT id, name, description, area_id, status FROM items
        WHERE hidden_at IS NULL AND is_private = false AND (
          search_vector @@ websearch_to_tsquery('english', ${query})
          OR name ILIKE ${'%' + query + '%'}
          OR word_similarity(${query}, coalesce(name, '')) > 0.3
          OR barcode = ${query})
        LIMIT 25`;
      const results = await Promise.all(
        rows.map(async (r) => ({ ...r, path: await pathOf(r.area_id) })),
      );
      return text({ results });
    },
  );

  server.registerTool(
    'list_areas',
    { description: 'List top-level storage areas (rooms, closets, bins).', inputSchema: {} },
    async () => {
      const rows = await db
        .select()
        .from(areas)
        .where(and(isNull(areas.parentId), isNull(areas.archivedAt)));
      return text({
        areas: rows.map((a) => ({ id: a.id, name: a.name, label_code: a.labelCode })),
      });
    },
  );

  server.registerTool(
    'area_contents',
    {
      description: 'Show what is inside an area: its sub-areas and items.',
      inputSchema: { area_id: z.string().uuid() },
    },
    async ({ area_id }) => {
      const crumb = await breadcrumb(area_id);
      if (!crumb.length) return text({ error: 'area not found' });
      const subs = await db
        .select()
        .from(areas)
        .where(and(eq(areas.parentId, area_id), isNull(areas.archivedAt)));
      const contents = await db
        .select()
        .from(items)
        .where(and(eq(items.areaId, area_id), isNull(items.hiddenAt), eq(items.isPrivate, false)))
        .orderBy(asc(items.createdAt));
      return text({
        path: crumb.map((c) => c.name ?? 'unnamed').join(' › '),
        subareas: subs.map((a) => ({ id: a.id, name: a.name })),
        items: contents.map((i) => ({
          id: i.id, name: i.name, quantity: i.quantity, status: i.status,
        })),
      });
    },
  );

  server.registerTool(
    'item_details',
    {
      description: 'Get details for one item, including where it is.',
      inputSchema: { item_id: z.string().uuid() },
    },
    async ({ item_id }) => {
      const [i] = await db.select().from(items).where(eq(items.id, item_id));
      if (!i || i.isPrivate) return text({ error: 'item not found' });
      const pics = await db.select().from(photos).where(eq(photos.itemId, item_id));
      return text({
        item: {
          id: i.id, name: i.name, description: i.description, quantity: i.quantity,
          barcode: i.barcode, status: i.status, lent_to: i.lentTo,
        },
        path: await pathOf(i.areaId),
        photos: pics.map((p) => photoUrl(p)),
      });
    },
  );

  server.registerTool(
    'move_item',
    {
      description: 'Move an item to a different area.',
      inputSchema: { item_id: z.string().uuid(), area_id: z.string().uuid() },
    },
    async ({ item_id, area_id }) => {
      const [i] = await db.select().from(items).where(eq(items.id, item_id));
      if (!i || i.isPrivate) return text({ error: 'item not found' });
      const [a] = await db.select().from(areas).where(eq(areas.id, area_id));
      if (!a || a.archivedAt) return text({ error: 'area not found' });
      await recordEvent('item.moved', 'item', item_id, {
        from_area_id: i.areaId, to_area_id: area_id,
      });
      await db.update(items).set({ areaId: area_id }).where(eq(items.id, item_id));
      return text({ ok: true, path: await pathOf(area_id) });
    },
  );

  server.registerTool(
    'resolve_label',
    {
      description: 'Resolve a QR label code (e.g. ST-000007) to its area.',
      inputSchema: { code: z.string() },
    },
    async ({ code }) => {
      const [l] = await db.select().from(labels).where(eq(labels.code, code.toUpperCase()));
      if (!l) return text({ error: 'unknown label' });
      if (!l.areaId) return text({ status: 'unclaimed' });
      const [a] = await db.select().from(areas).where(eq(areas.id, l.areaId));
      return text({
        status: 'area',
        area: a ? { id: a.id, name: a.name, path: await pathOf(a.id) } : null,
      });
    },
  );

  return server;
}

/**
 * Stateless Streamable HTTP endpoint - one transport per request. Each
 * connection (Settings → MCP) gets its own URL (/mcp/<slug>) PLUS a separate
 * bearer token in the Authorization header - the same split ChatGPT/Claude
 * connectors expect. No connections = no endpoint. Front with HTTPS to expose.
 */
export function registerMcp(app: FastifyInstance) {
  // Bare /mcp is not an endpoint - connections live at /mcp/<slug>.
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: (_req, reply) => reply.notFound(),
  });
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp/:slug',
    handler: async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const [conn] = await db.select().from(mcpTokens).where(eq(mcpTokens.slug, slug));
      if (!conn) return reply.notFound();
      if (req.headers.authorization !== `Bearer ${conn.token}`) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      db.update(mcpTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(mcpTokens.id, conn.id))
        .catch(() => {});
      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      reply.hijack();
      req.raw.on('close', () => {
        transport.close();
        server.close();
      });
      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  });
}

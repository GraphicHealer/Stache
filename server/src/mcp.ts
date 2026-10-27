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

  // Receipt/voice ingest paths: an assistant can file and annotate items.
  server.registerTool(
    'add_item',
    {
      description:
        'File a new item into the inventory (e.g. from a delivered-purchase receipt). ' +
        'Needs a home: pass area_id, a QR area_label like ST-000001, or area_name ' +
        '(matched loosely, created if absent).',
      inputSchema: {
        name: z.string().optional(),
        description: z.string().optional(),
        quantity: z.number().int().min(1).optional(),
        barcode: z.string().optional(),
        warranty_until: z.string().optional(), // YYYY-MM-DD
        restock_below: z.number().int().min(0).optional(),
        area_id: z.string().uuid().optional(),
        area_label: z.string().optional(),
        area_name: z.string().optional(),
      },
    },
    async ({ name, description, quantity, barcode, warranty_until, restock_below, area_id, area_label, area_name }) => {
      let areaId = area_id;
      if (!areaId && area_label) {
        const [l] = await db.select().from(labels).where(eq(labels.code, area_label.toUpperCase()));
        if (l?.areaId) areaId = l.areaId;
      }
      if (!areaId && area_name) {
        const [a] = await sql<{ id: string }[]>`
          SELECT id FROM areas WHERE archived_at IS NULL AND name ILIKE ${area_name} LIMIT 1`;
        if (a) {
          areaId = a.id;
        } else {
          const [created] = await db.insert(areas).values({ name: area_name }).returning();
          await recordEvent('area.created', 'area', created.id, { name: area_name });
          areaId = created.id;
        }
      }
      if (!areaId) return text({ error: 'no area given - pass area_id, area_label, or area_name' });
      const [area] = await db.select().from(areas).where(eq(areas.id, areaId));
      if (!area || area.archivedAt) return text({ error: 'area not found' });

      const [item] = await db
        .insert(items)
        .values({
          areaId,
          name: name ?? null,
          description: description ?? null,
          quantity: quantity ?? 1,
          barcode: barcode ?? null,
          warrantyUntil: warranty_until ?? null,
          restockBelow: restock_below ?? null,
        })
        .returning();
      await recordEvent('item.filed', 'item', item.id, { area_id: areaId, via: 'mcp' });
      return text({ ok: true, item_id: item.id, path: await pathOf(areaId) });
    },
  );

  server.registerTool(
    'update_item',
    {
      description:
        'Update an item (name, description, quantity, barcode, status, lent_to, warranty_until, restock_below). ' +
        'Useful for voice descriptions: "the drill is in the garage" -> update the item the user means.',
      inputSchema: {
        item_id: z.string().uuid(),
        name: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        quantity: z.number().int().min(1).optional(),
        barcode: z.string().nullable().optional(),
        status: z.enum(['home', 'out', 'lent', 'unaccounted', 'gone']).optional(),
        lent_to: z.string().nullable().optional(),
        warranty_until: z.string().nullable().optional(),
        restock_below: z.number().int().min(0).nullable().optional(),
      },
    },
    async ({ item_id, status, lent_to, ...fields }) => {
      const [i] = await db.select().from(items).where(eq(items.id, item_id));
      if (!i || i.isPrivate || i.hiddenAt) return text({ error: 'item not found' });

      const edits: Record<string, unknown> = {};
      const prev: Record<string, unknown> = {};
      const map = {
        name: 'name', description: 'description', quantity: 'quantity',
        barcode: 'barcode', warranty_until: 'warrantyUntil', restock_below: 'restockBelow',
      } as const;
      for (const [k, col] of Object.entries(map)) {
        const v = (fields as Record<string, unknown>)[k];
        if (v !== undefined && v !== (i as any)[col]) {
          prev[col] = (i as any)[col];
          edits[col] = v;
        }
      }
      if (Object.keys(prev).length) {
        await recordEvent('item.updated', 'item', item_id, { prev, next: edits });
      }

      if (status !== undefined && status !== i.status) {
        await recordEvent('item.status', 'item', item_id, {
          prev: {
            status: i.status, lent_to: i.lentTo, out_since: i.outSince,
            hidden_at: i.hiddenAt, takeout_count: i.takeoutCount, last_used: i.lastUsedAt,
          },
          next: { status, lent_to: lent_to ?? null },
        });
        edits.status = status;
        edits.lentTo = status === 'lent' ? (lent_to ?? i.lentTo) : null;
        if (status === 'home') {
          edits.outSince = null;
          edits.hiddenAt = null;
        } else {
          if (!i.outSince) edits.outSince = new Date();
          if (['out', 'lent'].includes(status) && i.status === 'home') {
            edits.lastUsedAt = new Date();
            edits.takeoutCount = i.takeoutCount + 1;
          }
          if (status === 'gone') edits.hiddenAt = new Date();
        }
      }
      if (!Object.keys(edits).length) return text({ ok: true, changed: false });
      await db.update(items).set(edits).where(eq(items.id, item_id));
      return text({ ok: true, changed: true, path: await pathOf(i.areaId) });
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

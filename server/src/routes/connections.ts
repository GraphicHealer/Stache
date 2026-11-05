import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { asc, and, eq } from 'drizzle-orm';
import { db } from '../db';
import { mcpTokens } from '../db/schema';
import { parseBody } from '../lib/validate';
import { z } from 'zod';

const ConnCreateSchema = z.object({
  name: z.string().min(1).max(60),
  scope: z.enum(['read', 'read-write']).optional(),
});

const ConnPatchSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(60),
}).strict();

/**
 * Personal AI connections - user-owned MCP endpoints. Each member manages
 * their own: shared integrations stay under the admin-gated
 * /api/settings/mcp routes. Owner identity comes from the session, never
 * from the request body.
 */
export async function connectionRoutes(app: FastifyInstance) {
  app.get('/api/me/mcp-connections', async (req) => ({
    connections: (
      await db
        .select()
        .from(mcpTokens)
        .where(and(eq(mcpTokens.ownerId, req.user!.id), eq(mcpTokens.kind, 'personal')))
        .orderBy(asc(mcpTokens.createdAt))
    ).map(({ token, tokenHash, ...c }) => c),
  }));

  app.post('/api/me/mcp-connections', async (req, reply) => {
    const body = parseBody(ConnCreateSchema, req.body, reply);
    if (!body) return;
    const token = crypto.randomBytes(24).toString('base64url');
    const [conn] = await db
      .insert(mcpTokens)
      .values({
        name: body.name.trim(),
        slug: crypto.randomBytes(9).toString('base64url'),
        token: null,
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        scope: body.scope ?? 'read-write',
        kind: 'personal',
        ownerId: req.user!.id,
      })
      .returning();
    const { token: _t, tokenHash: _h, ...pub } = conn;
    return reply.code(201).send({
      connection: pub,
      token,
      endpoint: `/mcp/${conn.slug}`,
      note: 'This token is shown once - store it like a password.',
    });
  });

  app.patch('/api/me/mcp-connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ConnPatchSchema, req.body, reply);
    if (!body) return;
    const [conn] = await db
      .select()
      .from(mcpTokens)
      .where(and(eq(mcpTokens.id, id), eq(mcpTokens.ownerId, req.user!.id)));
    if (!conn) return reply.notFound('connection not found');
    const [updated] = await db
      .update(mcpTokens)
      // name only - kind/scope/owner/slug/token are immutable through this path
      .set({ name: body.name.trim() })
      .where(eq(mcpTokens.id, id))
      .returning();
    const { token: _t, tokenHash: _h, ...pub } = updated;
    return { connection: pub };
  });

  app.delete('/api/me/mcp-connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [conn] = await db
      .select()
      .from(mcpTokens)
      .where(and(eq(mcpTokens.id, id), eq(mcpTokens.ownerId, req.user!.id)));
    if (!conn) return reply.notFound('connection not found');
    await db.delete(mcpTokens).where(eq(mcpTokens.id, id));
    return { ok: true };
  });
}

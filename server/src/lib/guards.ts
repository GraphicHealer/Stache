import type { FastifyReply, FastifyRequest } from 'fastify';

export const isAdmin = (req: FastifyRequest) => req.user?.role === 'admin';

/** preHandler: admin-only routes (settings, members, printer management). */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
}

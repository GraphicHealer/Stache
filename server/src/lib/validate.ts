import type { FastifyReply } from 'fastify';
import { z } from 'zod';

/**
 * Validate a JSON body against a zod schema. Returns the parsed value or
 * null after sending a 400 with the first issue. Usage:
 *
 *   const body = parseBody(Schema, req.body, reply); if (!body) return;
 */
export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
  reply: FastifyReply,
): z.infer<S> | null {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    reply.badRequest(`${issue.path.join('.') || 'body'}: ${issue.message}`);
    return null;
  }
  return r.data;
}

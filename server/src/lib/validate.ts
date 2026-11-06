import type { FastifyReply } from 'fastify';
import { z } from 'zod';

/**
 * Validate a JSON body against a zod schema. Returns the parsed value or
 * null after sending a 400 with the first issue. Usage:
 *
 *   const body = parseBody(Schema, req.body, reply); if (!body) return;
 */
/** Turn a zod issue into a short, user-readable reason (field name is prepended by the caller). */
function friendly(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return 'is required';
    case 'too_small':
      return issue.origin === 'string'
        ? `must be at least ${issue.minimum} character${issue.minimum === 1 ? '' : 's'}`
        : `must be at least ${issue.minimum}`;
    case 'too_big':
      return `must be at most ${issue.maximum}`;
    case 'invalid_value':
      return issue.values.length > 1 ? `must be one of: ${issue.values.join(', ')}` : 'has an invalid value';
    case 'unrecognized_keys':
      return `unknown field: ${issue.keys.join(', ')}`;
    default:
      return 'is invalid';
  }
}

export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
  reply: FastifyReply,
): z.infer<S> | null {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue.path.join('.') || 'body';
    reply.badRequest(`${field}: ${friendly(issue)}`);
    return null;
  }
  return r.data;
}

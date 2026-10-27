import { eq, or } from 'drizzle-orm';
import { items } from '../db/schema';

/**
 * Household visibility: items are shared by default. A private item is only
 * visible to its owner. `userId` null (e.g. MCP connections) sees shared only.
 */
export const itemVisible = (userId: string | null) =>
  userId ? or(eq(items.isPrivate, false), eq(items.ownerId, userId)) : eq(items.isPrivate, false);

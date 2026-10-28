import crypto from 'node:crypto';
import {
  sqliteTable, text, integer, real, index, uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// SQLite port: uuids are app-generated text; timestamps are INTEGER ms
// (drizzle `timestamp_ms` mode, Date objects both ways); booleans are
// INTEGER; jsonb became TEXT with drizzle `json` mode. CLIP embeddings live
// in the `item_embeddings` vec0 virtual table (migration SQL), not here.

const newId = () => crypto.randomUUID();
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const labels = sqliteTable('labels', {
  code: text('code').primaryKey(),
  batch: integer('batch').notNull().default(1),
  areaId: text('area_id'),
  createdAt: ts('created_at').notNull().$defaultFn(() => new Date()),
});

export const areas = sqliteTable('areas', {
  id: text('id').primaryKey().$defaultFn(newId),
  parentId: text('parent_id'),
  name: text('name'),
  coverPhotoId: text('cover_photo_id'),
  labelCode: text('label_code').unique(),
  createdAt: ts('created_at').notNull().$defaultFn(() => new Date()),
  archivedAt: ts('archived_at'),
}, (t) => [index('areas_parent_idx').on(t.parentId)]);

export const items = sqliteTable('items', {
  id: text('id').primaryKey().$defaultFn(newId),
  areaId: text('area_id').notNull(),
  name: text('name'),
  description: text('description'),
  quantity: integer('quantity').notNull().default(1),
  barcode: text('barcode'),
  status: text('status').notNull().default('home'), // home | out | lent | unaccounted | gone
  lentTo: text('lent_to'),
  outSince: ts('out_since'),
  lastUsedAt: ts('last_used_at'),
  takeoutCount: integer('takeout_count').notNull().default(0),
  remindSnoozedUntil: ts('remind_snoozed_until'),
  warrantyUntil: text('warranty_until'), // optional "covered until" date, YYYY-MM-DD
  restockBelow: integer('restock_below'), // optional "alert when qty <= this"
  notHereCount: integer('not_here_count').notNull().default(0),
  hiddenAt: ts('hidden_at'),
  createdAt: ts('created_at').notNull().$defaultFn(() => new Date()),
  aiName: text('ai_name'),
  aiDescription: text('ai_description'),
  aiTags: text('ai_tags', { mode: 'json' }),
  aiStatus: text('ai_status').notNull().default('off'), // off | pending | done | failed
  ocrText: text('ocr_text'),
  detectedCodes: text('detected_codes', { mode: 'json' }), // [{format, text}] found in photos, unconfirmed
  // Household sharing: shared by default; private items are owner-only.
  ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
  isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),
  // Client-generated idempotency key - offline replays dedupe on it.
  clientId: text('client_id'),
  // Set when CLIP finds a near-identical photo of another item at filing time.
  duplicateOf: text('duplicate_of'),
}, (t) => [
  index('items_area_idx').on(t.areaId),
  uniqueIndex('items_client_id_idx').on(t.clientId),
  index('items_barcode_idx').on(t.barcode),
  index('items_status_idx').on(t.status),
]);

export const photos = sqliteTable('photos', {
  id: text('id').primaryKey().$defaultFn(newId),
  itemId: text('item_id'),
  areaId: text('area_id'),
  path: text('path').notNull(),      // filename under DATA_DIR/photos
  thumbPath: text('thumb_path'),
  width: integer('width'),
  height: integer('height'),
  createdAt: ts('created_at').notNull().$defaultFn(() => new Date()),
}, (t) => [
  index('photos_item_idx').on(t.itemId),
  index('photos_area_idx').on(t.areaId),
]);

export const events = sqliteTable('events', {
  id: text('id').primaryKey().$defaultFn(newId),
  type: text('type').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  payload: text('payload', { mode: 'json' }),
  userId: text('user_id'),
  undoneAt: ts('undone_at'),
  createdAt: ts('created_at').notNull().$defaultFn(() => new Date()),
}, (t) => [
  index('events_created_idx').on(t.createdAt),
  index('events_entity_idx').on(t.entityId),
]);

export const printers = sqliteTable('printers', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull(),
  type: text('type').notNull(), // zpl | cups | dymo
  host: text('host'),
  port: integer('port').notNull().default(9100),
  queue: text('queue'),
  dpi: integer('dpi').notNull().default(203),
  labelWmm: real('label_w_mm').notNull().default(57),
  labelHmm: real('label_h_mm').notNull().default(32),
  createdAt: ts('created_at').notNull().$defaultFn(() => new Date()),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

// --- Better Auth tables (export names must match its model names) ------------

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  /** 'admin' (first account) | 'member'. Gates settings/users/printers. */
  role: text('role').notNull().default('member'),
  createdAt: ts('created_at').notNull().$defaultFn(() => new Date()),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: ts('expires_at').notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at').notNull().$defaultFn(() => new Date()),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: ts('access_token_expires_at'),
  refreshTokenExpiresAt: ts('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: ts('created_at').notNull().$defaultFn(() => new Date()),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').$defaultFn(() => new Date()),
  updatedAt: ts('updated_at').$defaultFn(() => new Date()),
});

export const mcpTokens = sqliteTable('mcp_tokens', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** Legacy plaintext column - nulled after hashing. Keep for migration. */
  token: text('token'),
  tokenHash: text('token_hash'),
  createdAt: ts('created_at').notNull().$defaultFn(() => new Date()),
  lastUsedAt: ts('last_used_at'),
});

export type Label = typeof labels.$inferSelect;
export type Area = typeof areas.$inferSelect;
export type Item = typeof items.$inferSelect;
export type Photo = typeof photos.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Printer = typeof printers.$inferSelect;
export type McpToken = typeof mcpTokens.$inferSelect;

import {
  pgTable, uuid, text, integer, real, boolean, timestamp, date, jsonb, index, uniqueIndex, vector,
} from 'drizzle-orm/pg-core';

export const labels = pgTable('labels', {
  code: text('code').primaryKey(),
  batch: integer('batch').notNull().default(1),
  areaId: uuid('area_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const areas = pgTable('areas', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentId: uuid('parent_id'),
  name: text('name'),
  coverPhotoId: uuid('cover_photo_id'),
  labelCode: text('label_code').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [index('areas_parent_idx').on(t.parentId)]);

export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  areaId: uuid('area_id').notNull(),
  name: text('name'),
  description: text('description'),
  quantity: integer('quantity').notNull().default(1),
  barcode: text('barcode'),
  status: text('status').notNull().default('home'), // home | out | lent | unaccounted | gone
  lentTo: text('lent_to'),
  outSince: timestamp('out_since', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  takeoutCount: integer('takeout_count').notNull().default(0),
  remindSnoozedUntil: timestamp('remind_snoozed_until', { withTimezone: true }),
  warrantyUntil: date('warranty_until', { mode: 'string' }), // optional "covered until"
  restockBelow: integer('restock_below'), // optional "alert when qty <= this"
  notHereCount: integer('not_here_count').notNull().default(0),
  hiddenAt: timestamp('hidden_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  aiName: text('ai_name'),
  aiDescription: text('ai_description'),
  aiTags: jsonb('ai_tags'),
  aiStatus: text('ai_status').notNull().default('off'), // off | pending | done | failed
  embedding: vector('embedding', { dimensions: 512 }),
  ocrText: text('ocr_text'),
  detectedCodes: jsonb('detected_codes'), // [{format, text}] found in photos, unconfirmed
  // Household sharing: shared by default; private items are owner-only.
  ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
  isPrivate: boolean('is_private').notNull().default(false),
}, (t) => [index('items_area_idx').on(t.areaId)]);

export const photos = pgTable('photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: uuid('item_id'),
  areaId: uuid('area_id'),
  path: text('path').notNull(),      // filename under DATA_DIR/photos
  thumbPath: text('thumb_path'),
  width: integer('width'),
  height: integer('height'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('photos_item_idx').on(t.itemId),
  index('photos_area_idx').on(t.areaId),
]);

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  payload: jsonb('payload'),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('events_created_idx').on(t.createdAt)]);

export const printers = pgTable('printers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  type: text('type').notNull(), // zpl | cups | dymo
  host: text('host'),
  port: integer('port').notNull().default(9100),
  queue: text('queue'),
  dpi: integer('dpi').notNull().default(203),
  labelWmm: real('label_w_mm').notNull().default(57),
  labelHmm: real('label_h_mm').notNull().default(32),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

// --- Better Auth tables (export names must match its model names) ------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const mcpTokens = pgTable('mcp_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export type Label = typeof labels.$inferSelect;
export type Area = typeof areas.$inferSelect;
export type Item = typeof items.$inferSelect;
export type Photo = typeof photos.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Printer = typeof printers.$inferSelect;
export type McpToken = typeof mcpTokens.$inferSelect;

import {
  pgTable, uuid, text, integer, real, timestamp, jsonb, index, uniqueIndex, vector,
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
  status: text('status').notNull().default('home'), // home | out | lent
  lentTo: text('lent_to'),
  outSince: timestamp('out_since', { withTimezone: true }),
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

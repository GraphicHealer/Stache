-- Personal MCP connections: a connection can belong to a user (kind='personal',
-- owner_id set) and sees shared + that owner's private items. Existing rows are
-- 'shared' with NULL owner - unchanged behavior.
ALTER TABLE mcp_tokens ADD COLUMN owner_id TEXT;
ALTER TABLE mcp_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'shared';

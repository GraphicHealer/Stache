# Stache — Final Pre-Release Fix & Validation

The three outstanding code-review items have been implemented. Before considering this work complete, address one remaining search issue and perform final validation.

## 1. Fix SQL search wildcard handling

> **✅ DONE** — LIKE metacharacters are escaped (`[\%_]` → backslash-escaped) with an explicit `ESCAPE '\'` clause - `%`/`_`/`\` in a query match literally, matching the old `includes()` semantics. Filtering, counting, and pagination stay in SQL. Tests: `q=%` matches an item containing '%', `q=5_%` proves `_` isn't a wildcard (returns 0 against '50%').

**File:** `server/src/routes/ext.ts`

The current implementation strips `%` and `_` from search queries:

```typescript
const needle = q.replace(/[%_]/g, '');
```

This changes the previous search behavior. JavaScript's `includes()` treated these characters literally, whereas SQL `LIKE` interprets them as wildcards.

### Required change

- Preserve literal `%` and `_` characters in user searches.
- Escape SQL `LIKE` metacharacters properly.
- Use an explicit SQL `ESCAPE` clause.
- Preserve case-insensitive, partial matching.
- Keep filtering, counting, and pagination in SQL.
- Do not regress existing search behavior across name, description, barcode, and tags.

### Regression tests

Add tests verifying:

- Searching for `%` finds only records containing a literal percent sign.
- Searching for `_` finds only records containing a literal underscore.
- Ordinary partial and case-insensitive searches still work.
- Combined search, area, and status filters still work.
- Pagination and total counts remain correct.

## 2. Final validation

Run the following checks against the latest commit:

- [ ] Complete server test suite.
- [ ] MCP authorization regression tests.
- [ ] Personal MCP connection management tests.
- [ ] REST API search and pagination tests.
- [ ] TypeScript type-check.
- [ ] Server production build.
- [ ] Frontend production build.
- [ ] Home Assistant integration compatibility check.

Report the actual results. Do not mark a check successful unless it was executed.

## 3. Final security sanity check

Confirm:

- Shared MCP connections can access shared inventory only.
- Personal MCP connections can access shared inventory and their owner's private inventory.
- No connection can access another user's private inventory.
- Orphaned private items with `owner_id = NULL` are inaccessible to everyone.
- Read-only connections cannot perform writes.
- Renaming a connection does not change its token, scope, owner, or endpoint.
- Revoked connections immediately lose access.
- Existing Home Assistant shared integrations continue to work.

## Completion criteria

Once the literal wildcard search issue is fixed and all applicable tests and builds pass, consider the outstanding review work complete.

Avoid another broad architectural rewrite. Keep any additional changes limited to genuine bugs or release-blocking issues.
# Stache — Final MCP Security and API Follow-ups

Repository: https://github.com/GraphicHealer/Stache

## Objective

Address three remaining improvements identified during the latest code review:

1. Fix an MCP authorization vulnerability involving orphaned private inventory items.
2. Add personal MCP connection renaming.
3. Improve REST API search scalability by moving filtering into SQL rather than loading the entire inventory into application memory.

Inspect the latest code before making changes. Some implementation may have changed since the review. Preserve existing functionality and avoid unnecessary refactoring.

---

# 1. P1 — Fix orphaned private-item MCP authorization

> **✅ DONE** — `owns()` now requires a non-null `conn.ownerId` for private access (`!!conn.ownerId && i.ownerId === conn.ownerId`). `searchItemIds`/`itemVisible` were verified safe (SQL `NULL = NULL` is never true). Orphan regression test covers direct-ID + search for shared AND personal conns + item unchanged.

**Priority: Critical security fix**

### Problem

File: `server/src/mcp.ts`

The current ownership helper was identified as:

```typescript
const owns = (i: { isPrivate: boolean; ownerId: string | null }) =>
  !i.isPrivate || i.ownerId === conn.ownerId;
```

This contains an authorization vulnerability.

When a user is deleted, private inventory items can retain `is_private = true` while their `owner_id` becomes `NULL` through the database's `ON DELETE SET NULL` behavior.

Shared MCP connections also have `conn.ownerId = NULL`.

Consequently, this comparison succeeds:

```typescript
i.isPrivate === true
i.ownerId === null
conn.ownerId === null
```

This can allow a shared MCP connection to access orphaned private inventory through direct item lookup or write operations.

This contradicts the intended security behavior: private items belonging to deleted users must become inaccessible to everyone.

### Required fix

Replace the authorization logic with an explicit owner-presence check:

```typescript
const owns = (i: { isPrivate: boolean; ownerId: string | null }) =>
  !i.isPrivate || (!!conn.ownerId && i.ownerId === conn.ownerId);
```

Alternatively, use the existing shared authorization helper consistently if it provides the same behavior.

The important rule is:

**A private item is accessible only when the connection has a non-null owner ID that exactly matches the item's non-null owner ID.**

A null owner must never match another null owner for authorization purposes.

### Audit all MCP operations

Do not limit the fix to `item_details`.

Review every MCP operation that accesses or modifies an existing item, including:

- Item detail retrieval.
- Item updates.
- Item movement.
- Quantity changes.
- Status changes.
- Tag changes.
- Item links.
- History and event retrieval.
- Photo access.
- Any other direct-ID operation.

Ensure all these operations use the same ownership-aware authorization rules.

Also inspect any operations that accept area IDs or other related resource IDs to ensure they cannot expose orphaned private information indirectly.

### Regression tests

Add explicit tests covering the following:

1. Create a private item owned by User B.
2. Delete User B.
3. Verify the item still has `is_private = true` and `owner_id = NULL`.
4. Attempt to retrieve the item using a shared MCP connection.
5. Attempt to update the item using a shared MCP connection.
6. Attempt to move the item using a shared MCP connection.
7. Verify all operations deny access.
8. Verify the item remains unchanged.
9. Attempt to retrieve the item using User A's personal MCP connection.
10. Verify User A cannot access the orphaned item either.
11. Verify a shared MCP connection can still access ordinary shared items.
12. Verify a personal MCP connection can still access its owner's private items.

Test both direct-ID access and search-based access.

Do not change the intended behavior of ordinary shared inventory.

### Acceptance criteria

- Shared connections cannot access orphaned private items.
- Personal connections cannot access orphaned private items.
- Direct-ID access cannot bypass visibility restrictions.
- Write operations cannot modify orphaned private items.
- Existing shared and personal inventory access continues working.
- Regression tests cover the null-owner scenario.

---

# 2. P2 — Add personal MCP connection renaming

> **✅ DONE** — `PATCH /api/me/mcp-connections/:id` (strict `{name}` schema, owner-scoped 404, only `name` writable). UI: pencil → inline input → check/x, list refreshes without reload. Tests cover rename, ownership, empty/whitespace/length, sensitive-field rejection, token still works.

**Priority: Functional improvement**

### Current behavior

The personal connection management routes currently provide:

- `GET /api/me/mcp-connections`
- `POST /api/me/mcp-connections`
- `DELETE /api/me/mcp-connections/:id`

The original feature requirements also included allowing users to rename their connections.

Review the current implementation and add this capability if it remains missing.

### API implementation

Add:

```http
PATCH /api/me/mcp-connections/:id
```

Expected request:

```json
{
  "name": "My Claude Assistant"
}
```

Requirements:

- Require an authenticated user session.
- Validate the name with the same rules used during connection creation.
- Trim whitespace.
- Enforce the existing maximum name length.
- Reject empty names.
- Only allow modification of connections owned by the authenticated user.
- Never allow the request to modify `owner_id`, `kind`, `scope`, token hashes, slugs, or other security-sensitive fields.
- Return 404 when the connection does not exist or does not belong to the authenticated user.
- Return the updated public connection object without exposing token material.

Use the existing validation patterns and response conventions.

### UI implementation

Review the AI Connections settings page.

Add an intuitive rename action for each personal connection.

Suggested interaction:

- Display the current connection name.
- Provide a small edit/rename action.
- Allow the user to enter a replacement name.
- Save the change.
- Update the displayed name without requiring a full page reload, if consistent with the existing frontend architecture.
- Show useful validation errors.

Do not expose unnecessary technical details.

### Tests

Add tests verifying:

1. A user can rename their own connection.
2. The updated name appears in the connection list.
3. A user cannot rename another user's connection.
4. Empty names are rejected.
5. Whitespace-only names are rejected.
6. Overlength names are rejected.
7. Security-sensitive fields cannot be modified through the rename endpoint.
8. Existing credentials and connection functionality remain unchanged after renaming.

### Acceptance criteria

Users can rename their own personal MCP connections without affecting their credentials, permissions, ownership, or endpoint.

---

# 3. P2 — Improve REST API search scalability

> **✅ DONE** — `q` now runs in SQL (`lower(col) LIKE '%q%'` over name/description/barcode/tags) in the same WHERE as visibility/area/status; LIMIT/OFFSET + `count(*)` in SQL — no more full-table load. Wildcards stripped (literal semantics preserved); bare-wildcard query returns 0. No new indexes (LIKE '%..%' can't use them anyway).

**Priority: Performance and scalability**

### Problem

The ordinary versioned REST API listing has been updated to use SQL pagination.

However, the `q` search path was previously identified as loading candidate inventory records into application memory and filtering them in JavaScript.

This creates unnecessary memory and processing overhead as inventories grow.

Review the current implementation and determine whether this behavior still exists.

### Required improvement

Move ordinary REST API search filtering into the database query wherever practical.

The goal is to avoid loading the entire inventory into memory just to return a limited search result.

Preserve existing API behavior and visibility restrictions.

### Search behavior to preserve

Review the existing `/api/v1/items` query parameters and preserve supported functionality, including:

- Text search (`q`).
- Area filtering.
- Status filtering.
- Pagination.
- Existing visibility restrictions.
- Stable sorting.
- Total result counts or existing pagination metadata.

Do not remove existing search capabilities simply to simplify the query.

### Database filtering

Use SQL/Drizzle query conditions for applicable filters.

At minimum:

- Apply shared/private visibility restrictions in SQL.
- Apply area filters in SQL.
- Apply status filters in SQL.
- Apply text search in SQL where appropriate.
- Apply pagination in SQL.
- Avoid fetching all candidate items before filtering.

For text matching, inspect the existing database capabilities before selecting an implementation.

Potential approaches include:

- SQLite `LIKE` or case-insensitive matching.
- Existing FTS5 indexes, if compatible with the desired API semantics.
- Existing normalized search columns or other indexed search mechanisms.

Do not introduce a second search engine or duplicate the full internal hybrid-search implementation unnecessarily.

### Important: Preserve search semantics

The REST API should not unexpectedly behave differently after the optimization.

Check:

- Case-insensitive matching.
- Partial matching.
- Special characters.
- Empty search queries.
- Combined filters.
- Sorting.
- Pagination boundaries.

If the current API has defined search behavior, preserve it.

If a more efficient SQL implementation necessarily changes a minor detail, document the difference and add tests.

### Performance considerations

Consider indexes for frequently used filters if the current schema does not already provide them.

Potential candidates:

- `area_id`
- `status`
- `is_private`
- `owner_id`

Do not blindly add every possible index. Consider actual query patterns, existing indexes, and SQLite write overhead.

Use query plans or representative benchmarks where practical to verify that the new implementation avoids full-table application-level filtering.

### Tests

Add or update tests verifying:

1. Text search returns the expected matches.
2. Search is case-insensitive if that is the existing behavior.
3. Partial matches behave consistently.
4. Area and status filters work independently.
5. Combined filters work correctly.
6. Pagination returns the correct pages.
7. Total counts match filtered results.
8. Shared connections cannot search private items.
9. Personal connections or REST API users retain their intended visibility boundaries.
10. Hidden items remain excluded according to existing rules.
11. Empty and malformed search parameters are handled correctly.

### Acceptance criteria

- Filtering occurs in SQL wherever practical.
- Pagination is performed in SQL.
- The application no longer loads the entire candidate inventory into memory for ordinary REST API searches.
- Existing API response formats remain compatible.
- Search results preserve visibility and privacy restrictions.
- Tests cover combinations of filters and pagination.

---

# Implementation order

Complete the work in this order:

## Phase 1 — Security

Fix the orphaned private-item authorization vulnerability first.

Add regression tests and verify all MCP operations that use direct item IDs.

Do not proceed on the assumption that the fix is complete until the tests pass.

## Phase 2 — Personal connection management

Implement the rename endpoint, ownership checks, frontend interaction, and tests.

Keep the implementation consistent with existing personal connection management.

## Phase 3 — Search scalability

Move REST API filtering into SQL, preserve existing behavior, and add tests for filters, pagination, and visibility.

Only add indexes where justified.

---

# Final validation

Before marking this work complete:

- Run the relevant core server test suite.
- Run the MCP authorization tests.
- Run REST API search and pagination tests.
- Run frontend tests or the applicable website build.
- Check for TypeScript errors.
- Review database migrations, if any.
- Verify existing personal and shared MCP connections still work.
- Verify Home Assistant integration behavior has not changed.
- Report the actual test results.

Do not claim tests passed unless they were executed.

## Final priorities

1. **Security:** No shared or personal MCP connection may access orphaned private inventory.
2. **Usability:** Users can rename their personal AI connections.
3. **Scalability:** REST API searches filter and paginate in SQL rather than loading the full inventory into application memory.

Keep the changes focused. This is a final hardening pass, not an invitation for another broad architectural rewrite.
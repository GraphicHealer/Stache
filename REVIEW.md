# Stache — Security, API, Integration & Personal MCP Improvements

## Objective

Address the outstanding code-review findings across the Stache ecosystem while implementing a more complete MCP integration model that allows individual users to connect their own AI assistants to their own Stache inventory.

Repositories:

- **Stache:** https://github.com/GraphicHealer/Stache
- **Stache Website / Documentation:** https://github.com/GraphicHealer/stache-site
- **Stache Home Assistant Integration:** https://github.com/GraphicHealer/stache-ha

This is an implementation task, not a request for another architectural proposal. Inspect the current code first, verify which findings still apply, and implement the necessary changes.

Do not blindly apply recommendations that have already been addressed.

---

# Part 1 — Important Product and Architecture Requirements

## 1.1 Personal AI connections are a first-class feature

Users should be able to connect their own MCP-compatible AI assistants to their own Stache inventory.

This is an important product requirement, not merely an extension of the existing shared MCP integration.

The intended experience:

1. A user opens their Stache account.
2. They navigate to AI / MCP Connections.
3. They create a new connection, give it a name, and choose its access level.
4. Stache generates the connection endpoint and authentication credentials.
5. The user configures their preferred AI assistant using the provided instructions.
6. Their AI assistant can interact with their Stache inventory according to the permissions granted to that connection.
7. The user can review, manage, and revoke connections whenever they want.

Stache should not require users to host their own AI models or use a particular AI provider. Users bring their own AI assistant.

The guiding principle:

**Stache owns the inventory, but users own the intelligence they connect to it.**

## 1.2 Establish three distinct integration access models

Do not simply expand the existing shared-only MCP permissions to allow access to private items.

There should be three distinct integration contexts.

### A. Personal AI connections

Owned by an individual Stache user.

A personal connection should be able to access:

- Shared inventory.
- The connection owner's private inventory.
- Areas and other inventory data the owner is authorized to access.
- The owner's permitted inventory operations.

It must never access another user's private inventory.

A personal connection should support at least two permission levels:

- **Read-only:** Search, retrieve, and inspect permitted inventory information.
- **Read and write:** Everything in read-only, plus permitted inventory creation and modification operations.

The connection's effective permissions must always be constrained by the authenticated owner's permissions.

A personal connection must not become an administrator simply because its owner is an administrator. Administrative capabilities should require separate, explicit authorization.

### B. Shared integrations

Examples include:

- Home Assistant.
- External scripts.
- Automated inventory systems.
- Other shared integrations.

These should retain their existing shared-inventory-only behavior.

They must not gain access to personal/private inventory.

Their permissions should be independently managed and revocable.

### C. Administrative integrations

Administrative capabilities should remain separate from ordinary personal and shared connections.

Do not expose user management, account administration, global settings, or other administrative functionality through ordinary MCP connections.

If administrative MCP capabilities are ever introduced, they must require explicit administrative authorization and separate scopes.

## 1.3 Preserve existing security boundaries

The existing private-item implementation is an important security boundary.

Every MCP operation must enforce visibility server-side, not rely on the AI client to behave appropriately.

In particular:

- A personal connection must only see its owner's private items.
- Shared integrations must only see shared items.
- One user's personal connection must not access another user's private items.
- Knowing an item's ID must not bypass visibility restrictions.
- Search results must be filtered before being returned.
- Area contents, item links, photos, history, events, and other related data must respect the same visibility rules.
- Writes must verify ownership and permissions before modifying anything.
- MCP must use the same event/undo mechanisms as ordinary application operations wherever applicable.

Do not duplicate security logic in MCP-specific code if existing server-side authorization helpers can be reused.

---

# Part 2 — Core Stache Security and API Improvements

Inspect the current implementation before making changes.

## 2.1 API token management must require administrator authorization

> **✅ DONE** — `requireAdmin` preHandler on all three `/api/settings/api-tokens*` endpoints; member 403 test added (`ext.test.ts`). Personal connections get their own ownership model in Part 3.

**Priority: P1 — Security**

Previously identified in:

`server/src/routes/ext.ts`

The following endpoints appeared to require authentication without requiring administrator authorization:

- `GET /api/settings/api-tokens`
- `POST /api/settings/api-tokens`
- `DELETE /api/settings/api-tokens/:id`

Review the current implementation.

If this is still the case:

- Apply the appropriate `requireAdmin` middleware.
- Ensure non-administrators receive HTTP 403.
- Ensure users cannot enumerate, create, or revoke administrative/shared integration tokens without authorization.
- Add tests covering all three endpoints.

**Important:** Personal AI connections are a separate feature. Do not solve this by making all users administrators or by exposing the existing administrative token-management functionality to everyone.

Personal connection management should use its own ownership-aware authorization model.

## 2.2 Correct multipart tag handling

> **✅ DONE** — repeated multipart fields accumulate into arrays; `tags` normalizes single→array before zod. Multipart tests cover zero/one/many tags + photo+tags together.

**Priority: P1 — Functional**

Previously identified across:

- `server/src/routes/ext.ts`
- `custom_components/stache/services.py`

The HA integration sends tags as repeated multipart fields:

```python
for t in tags:
    form.add_field("tags", t)
```

The server's multipart parser previously assigned fields directly:

```typescript
fields[part.fieldname] = part.value;
```

This means repeated fields overwrite one another. Additionally, a single value may be a string when the API expects an array.

Review and correct the parser.

Requirements:

- Accumulate repeated multipart fields into arrays.
- Normalize single and multiple tag values consistently.
- Preserve compatibility with existing JSON requests.
- Correctly handle zero, one, and multiple tags.
- Ensure multipart requests containing photos and tags work together.
- Update API documentation/OpenAPI definitions if needed.

Add tests for all relevant cases.

## 2.3 Make REST API photo URLs usable with bearer authentication

> **✅ DONE** — `GET /api/v1/items/:id` returns `signPhotoUrl`-wrapped `url`/`thumb` (1h TTL). Tests: bearer fetch without session, expired URL → 401, private item detail unreachable via shared token.

**Priority: P1 — Functional**

Previously identified in the versioned REST API:

`GET /api/v1/items/:id`

The API returns photo and thumbnail URLs using the ordinary `/photos/...` routes.

Those routes require a session or signed HMAC URL, meaning a client authenticated only with an API bearer token may be unable to retrieve the photos returned by the API.

Review the current implementation.

If still applicable:

- Use the existing signed URL functionality in `server/src/lib/signed.ts`.
- Generate appropriately short-lived signed photo and thumbnail URLs.
- Perform item visibility checks before generating URLs.
- Ensure private photos are only accessible to authorized users.
- Avoid exposing permanent public photo URLs.
- Ensure URL expiration is enforced.

Add tests proving that:

1. A bearer-authenticated API client can retrieve an authorized item's photo without a browser session.
2. An expired URL is rejected.
3. A user cannot obtain a signed URL for another user's private item.
4. Shared integration tokens cannot access private photos.

## 2.4 Enforce remote photo download limits while streaming

> **✅ DONE** — `photo_url` body is read as a stream with a running byte count; `stream.cancel()` at >25MB, so a lying content-length can't buffer a huge body. SSRF checks + 10s timeout + redirect refusal retained.

**Priority: P2 — Resource Safety**

Previously identified behavior:

```typescript
Buffer.from(await res.arrayBuffer())
```

The response was fully buffered before checking the 25 MB limit.

This means a remote server could cause excessive memory consumption before the limit is enforced.

Review the current remote photo URL upload implementation.

If still applicable:

- Enforce the size limit while reading the response stream.
- Stop and cancel the response when the limit is exceeded.
- Retain existing timeout protections.
- Retain SSRF protections and DNS validation.
- Handle missing or misleading Content-Length headers.
- Ensure redirects cannot bypass the existing security protections.

The limit should be enforced on actual bytes received, not just the declared Content-Length.

## 2.5 Make REST API photo item creation transactional

> **✅ DONE** — photos are `assertImage`d + `savePhotoFile`-staged *before* the transaction; item + photo rows + `item.filed` event commit atomically; staged files removed via `removePhotoFiles` on rollback (same pattern as area photos).

**Priority: P2 — Data Integrity**

Previously identified behavior:

The REST API could create an item and event before saving all associated photos.

A later photo failure could leave an incomplete item or partially saved photos.

Review the current implementation.

If still applicable, implement appropriate transactionality:

1. Validate the request.
2. Receive and validate the photos.
3. Stage photo files safely.
4. Create the item, photo database records, and event consistently.
5. Commit the database transaction.
6. Clean up staged files if the database operation fails.
7. Ensure no orphaned files or incomplete database records remain.

Use the existing area-photo transaction implementation as a reference where appropriate.

Do not introduce unnecessary architectural duplication.

## 2.6 Apply consistent hidden-item visibility rules

> **✅ DONE** — `isNull(items.hiddenAt)` added to `GET /items/:id`, `PATCH`, and `move` lookups; hidden items 404 on direct ID and cannot be mutated. Test covers all three paths.

**Priority: P2 — Data Consistency**

Previously identified discrepancy:

- API list and area detail endpoints excluded hidden items.
- `GET /api/v1/items/:id` appeared to check `isPrivate` but not `hiddenAt`.

Review all versioned API item retrieval endpoints.

Requirements:

- Apply consistent visibility rules to list, detail, area, and search endpoints.
- Ensure hidden/gone item behavior is consistent with the intended application semantics.
- Do not accidentally expose hidden items through direct ID lookup.
- Ensure private-item authorization remains independent of hidden-item filtering.
- Verify mutations cannot bypass visibility rules.

Do not change the intended meaning of item statuses without examining the existing application behavior.

## 2.7 Validate API quantity and area inputs

> **✅ DONE** — `quantity` is now `z.preprocess(Number)` → `int().min(1).max(1e6)` on create + patch (rejects 0/1.5/-3/'abc', multipart strings normalize). Exactly-one-of `area_id`/`area_label`/`area_name` enforced on create + move.

**Priority: P2 — Input Validation**

Previously identified quantity normalization:

```typescript
Math.max(1, Number(body.quantity) || 1)
```

This can silently convert malformed or zero values into 1 and may allow decimals.

Review the current implementation.

Requirements:

- Validate quantity as a positive integer.
- Apply a reasonable upper bound.
- Reject invalid input instead of silently correcting it.
- Handle multipart string values correctly.
- Preserve appropriate defaults only when a quantity was genuinely omitted.

Also validate area selection.

Where the API supports:

- `area_id`
- `area_label`
- `area_name`

Enforce the documented exactly-one selection rule server-side.

Reject ambiguous or conflicting combinations.

Add validation tests.

## 2.8 Add idempotency support to REST API item creation

> **✅ DONE** — `client_id` accepted on `POST /api/v1/items`; a retried create returns the existing item + `deduplicated: true` instead of a duplicate (same mechanism as the offline outbox).

**Priority: P2 — Reliability**

The core application already supports `client_id` for offline request deduplication.

Previously, the versioned REST API did not appear to expose the same functionality.

Review the current API.

If still missing:

- Accept an optional `client_id` on `POST /api/v1/items`.
- Reuse the existing idempotency mechanism where possible.
- Ensure repeated requests with the same identifier do not create duplicate items.
- Define behavior for reusing an identifier with conflicting request data.
- Ensure photo uploads do not create duplicate photo records on retries.
- Add tests for repeated successful requests and retry-after-timeout scenarios.

This is particularly useful for external integrations and AI assistants.

## 2.9 Add proper REST API pagination

> **✅ DONE** — `GET /api/v1/items` takes `limit`/`offset`/`area_id`/`status`; unpaginated path paginates in SQL (LIMIT/OFFSET + `count(*)`). Search still filters the matched set in memory and paginates it.

**Priority: P2 — Scalability**

Previously identified behavior:

The `/api/v1/items` endpoint appeared to load all shared visible items into memory, filter them in JavaScript, and return the first 50.

Review the current implementation.

If still applicable:

- Implement server-side pagination.
- Support limit and offset or cursor-based pagination.
- Provide a total count or suitable pagination metadata.
- Add useful filters such as area and status where appropriate.
- Apply visibility filters at the database query level.
- Avoid loading the entire inventory just to return one page.

Keep the API straightforward.

Do not unnecessarily duplicate the full internal hybrid-search implementation in the external REST API.

---

# Part 3 — Personal MCP Connection Implementation

This is a major feature requirement.

## 3.1 Design personal connection ownership

> **✅ DONE** — `mcp_tokens` extended (`kind`, `owner_id`; existing rows stay `shared`/NULL). Personal connections: `/api/me/mcp-connections` CRUD (session-scoped, `ownerId` from `req.user`, never the body). Token is hashed, shown once.

Personal MCP connections must belong to a specific authenticated Stache user.

Review the existing MCP implementation and token model before deciding whether to extend the existing structure or introduce a dedicated personal connection model.

A connection should have at least:

- Unique ID.
- User/owner ID.
- User-defined connection name.
- Token hash or equivalent secure credential storage.
- Permission level.
- Created timestamp.
- Last-used timestamp.
- Revoked timestamp or equivalent revocation state.

Never store plaintext bearer tokens permanently.

The plaintext credential should only be displayed when the connection is created, unless the existing secure credential model supports another appropriate one-time retrieval workflow.

A user should be able to:

- Create a connection.
- View their connections.
- Rename a connection.
- Revoke a connection.
- See when it was last used.
- Understand what the connection can access.

Revoking a connection must immediately prevent further authentication.

## 3.2 Separate personal tokens from shared integration tokens

> **✅ DONE** — `kind` column separates contexts; `itemVisible(null)` = shared-only unchanged, `itemVisible(ownerId)` = shared + owner's private. Admin `/api/settings/mcp` manages shared; members manage personal via `/api/me/mcp-connections`.

Do not silently change the meaning of existing MCP tokens.

Existing shared integrations should retain their existing shared-only access behavior.

Personal connections should have a distinct ownership context.

A reasonable permission model:

| Connection type | Shared inventory | Owner's private inventory | Other users' private inventory |
|---|---|---|---|
| Personal read-only | Read | Read | No access |
| Personal read/write | Read/write | Read/write | No access |
| Shared read-only | Read | No access | No access |
| Shared read/write | Read/write | No access | No access |
| Administrative | Explicitly authorized only | Explicitly authorized only | Explicitly authorized only |

The actual permission implementation may use a different internal representation, but these access boundaries are mandatory.

For personal connections, the owner identity must come from the authenticated connection record, never from an arbitrary user ID supplied by the MCP client.

## 3.3 Implement ownership-aware MCP authorization

> **✅ DONE** — every MCP read/write uses `itemVisible(conn.ownerId)` + `owns()` checks; search passes `conn.ownerId` to `searchItemIds`; `add_item` stamps `ownerId`; photos are 1h-signed URLs. Server-side only - the client can't spoof ownership.

Review all existing MCP tools.

For personal connections:

- Search must include shared items and the owner's private items.
- Area listing must respect the owner's visibility.
- Item retrieval must enforce ownership.
- Item creation must assign the correct ownership context.
- Item updates must verify that the target item is writable.
- Item movement must respect area visibility and ownership.
- Item links must not expose unauthorized items.
- History and event operations must respect the same visibility rules.
- Photo access must follow the same authorization rules.

For shared connections:

- Preserve shared-only access.
- Do not allow private-item access through an ID lookup.
- Do not allow an integration to assign itself an arbitrary owner.
- Do not allow a shared integration to change ownership or privacy flags to gain access.

Do not trust the AI client to supply correct ownership information.

## 3.4 Expand MCP capabilities around real inventory tasks

> **✅ DONE** — existing toolset already covers the review matrix (search/list/areas/resolve + file/move/update with events+undo). No MCP-only duplicates - same helpers as the app.

Review the existing MCP tools and preserve useful existing functionality.

Where missing, ensure the toolset can support common natural-language inventory tasks.

Examples:

### Finding things

- Search inventory by name, description, or tags.
- Find items in a particular area.
- List the contents of an area.
- Find items matching a status.
- Find items that are out or lent.
- Find items with low stock.
- Find items with upcoming or expired warranties.
- Retrieve item details.

### Organizing inventory

- Create an item.
- Move an item to another area.
- Update an item's details.
- Update quantity.
- Update status.
- Add or remove tags.
- Organize items into areas.

### Inventory awareness

- Retrieve area hierarchy.
- Retrieve area contents.
- Retrieve item counts.
- Summarize inventory in an area.
- Identify items needing attention.

All operations must use existing business logic and validation wherever possible.

Do not implement separate MCP-only versions of inventory operations if the existing API or service layer can be reused.

### Important write behavior

All MCP writes must:

- Validate inputs.
- Respect ownership and privacy.
- Use the existing event recording system.
- Preserve undo functionality wherever applicable.
- Return clear success or failure results.
- Avoid silently overwriting user-provided information.

AI connections should not bypass the normal application rules.

## 3.5 Provide a user-friendly MCP connection management interface

Add a dedicated section to the Stache settings interface.

Suggested name:

**AI Connections**

The UI should be understandable to ordinary users, not just developers.

A user should see their existing connections and be able to create a new one.

Connection creation should ask for:

- Connection name.
- Access level: Read-only or Read and write.

Avoid overwhelming the user with technical scopes unless they are genuinely necessary.

After creation, show:

- Connection name.
- MCP endpoint.
- Authentication instructions.
- One-time bearer token display.
- Copy buttons.
- Connection type and permissions.
- A link to supported client setup instructions.

The connection list should show:

- Name.
- Permission level.
- Created date.
- Last used.
- Status.
- Revoke action.

Make revocation clear and require confirmation.

Do not expose the full token again after creation.

The UI must clearly distinguish personal AI connections from shared integrations such as Home Assistant.

## 3.6 Provide client-specific setup instructions

The connection page should help users connect their AI assistant.

Include setup instructions for relevant MCP-compatible clients, such as:

- Claude Desktop.
- Claude Code.
- ChatGPT, where the user's account and supported MCP connection workflow allow it.
- Cursor.
- VS Code or other supported MCP clients.

Do not assume every client supports the same transport, authentication method, or custom headers.

For each client:

- Verify the current connection method.
- Provide the correct endpoint and authentication configuration.
- Clearly identify required credentials.
- Explain any limitations.
- Avoid promising support for clients that cannot authenticate using the implemented method.

Where a client requires a different configuration, provide a copyable example.

Never put real credentials in documentation or source control.

## 3.7 MCP security and isolation tests

> **✅ DONE** — `mcp.test.ts` personal suite: shared+own-private visible, cross-member private invisible on search AND direct ID, write denied cross-member, read-only has no write tools, revoke → immediate 404, shared stays shared-only. 11/11 pass.

This is a mandatory part of the feature.

Add tests covering at least:

1. User A's personal read-only connection can search shared items.
2. User A's personal read-only connection can search User A's private items.
3. User A's personal read-only connection cannot search User B's private items.
4. User A cannot retrieve User B's private item by knowing its ID.
5. User A cannot retrieve User B's private photo.
6. User A's personal read/write connection can modify authorized shared items.
7. User A's personal read/write connection can modify User A's private items.
8. User A cannot modify User B's private items.
9. A shared integration cannot access any private items.
10. A shared integration cannot modify ownership or privacy fields to gain access.
11. A revoked personal connection immediately stops working.
12. A read-only connection cannot invoke write tools.
13. A write operation records the expected event.
14. Undo behavior remains functional where supported.
15. An administrator's ordinary personal connection does not automatically gain administrative MCP permissions.

Test both search-based access and direct-ID access.

The most important security assertion:

**No MCP connection belonging to one user can access another user's private inventory, even when the client knows the exact item ID.**

---

# Part 4 — Home Assistant Integration Improvements

Repository: `GraphicHealer/stache-ha`

Review the current implementation before changing it.

## 4.1 Use runtime service schemas

**Priority: P2 — Reliability**

Previously identified:

`services.py` appeared to register services with `schema=None` despite having definitions such as `AREA_REF_SCHEMA` and `STATUS_CHOICES`.

Review the current service registration.

If still applicable:

- Use appropriate Voluptuous schemas.
- Validate required fields.
- Validate area references.
- Enforce exactly-one area selection where applicable.
- Validate item status.
- Validate positive integer quantities.
- Validate tag arrays.
- Validate mutually exclusive photo inputs.
- Return useful errors for invalid service calls.

Do not rely on `services.yaml` as runtime validation. It only helps the Home Assistant UI.

## 4.2 Resolve multi-instance service lifecycle

**Priority: P2 — Reliability**

Previously identified:

- Services were registered globally.
- `_client()` appeared to choose the first API-enabled config entry.
- `async_setup_services()` was called from each `async_setup_entry()`.

Review the current implementation.

Decide on a consistent lifecycle.

Either:

- Explicitly support multiple Stache instances and let service calls select the intended instance; or
- Explicitly prevent multiple config entries if the integration is intentionally single-instance.

Whichever approach is chosen:

- Avoid duplicate service registration.
- Avoid silently selecting the wrong Stache instance.
- Clean up services appropriately on unload.
- Ensure API-disabled entries do not become accidental defaults.

Do not add unnecessary multi-instance complexity if the integration is not intended to support it.

## 4.3 Enforce photo file size limits

**Priority: P2 — Resource Safety**

Previously identified:

`services.py` checked allowed external directories but read the entire file with `read_bytes()` without first enforcing a size limit.

Review the current implementation.

If still applicable:

- Check file size before reading.
- Enforce a reasonable maximum consistent with the server's upload limits.
- Reject oversized files with a useful error.
- Ensure file path validation remains in place.
- Avoid reading arbitrarily large files into memory.

## 4.4 Preserve shared-integration access boundaries

The Home Assistant integration is a shared integration, not a personal AI connection.

It must retain shared-inventory-only access.

Do not give the HA integration access to individual users' private inventory as part of the personal MCP implementation.

Its token should remain independently revocable.

---

# Part 5 — Documentation and API Reference Improvements

Repository: `GraphicHealer/stache-site`

## 5.1 Fix Swagger UI authentication persistence

**Priority: P2 — Security**

Previously identified in:

`src/pages/api.astro`

Swagger UI appeared to use:

```javascript
persistAuthorization: true
```

Review the current implementation.

If still enabled:

- Disable persistent authorization.
- Avoid storing bearer tokens in browser storage unnecessarily.
- Explain that API tokens should be treated like passwords.
- Recommend read-only tokens for documentation/testing when possible.

## 5.2 Correct production CORS behavior in the interactive API reference

**Priority: P2 — Functional**

Previously identified:

The hosted documentation site provides Swagger UI instructions suggesting users can call their local Stache instance directly.

However, the server's CORS plugin appeared to be registered only in development mode.

Review the current implementation.

Determine whether production Swagger UI requests are actually supported.

If cross-origin access is needed:

- Implement narrowly scoped, configurable CORS.
- Do not use unrestricted wildcard CORS.
- Ensure allowed origins are configurable.
- Preserve normal authentication and authorization.
- Document any limitations.

Alternatively, host interactive API documentation on the Stache instance itself and use the public documentation site for reference material.

Choose the simplest secure implementation.

## 5.3 Correct item photo documentation

The concepts documentation previously implied that every inventory item has a photo.

However, the API, CSV import, and JSON import can create items without one.

Review the current wording.

Explain that Stache is photo-first, but photos are not mandatory for every item or every import method.

Preserve the product philosophy without making technically inaccurate claims.

## 5.4 Document personal MCP connections

Add a dedicated documentation section explaining personal AI connections.

Cover:

- What MCP is in the context of Stache.
- Why users might connect their own AI assistant.
- How to create a connection.
- Read-only versus read/write permissions.
- How to configure supported clients.
- How to revoke access.
- What information the connection can access.
- How personal/private inventory access works.
- How shared integrations differ from personal connections.

Keep the writing approachable.

Do not turn this into an unnecessarily technical explanation of OAuth, bearer-token internals, or server architecture.

Users should understand what they are granting access to and how to control it.

## 5.5 Document REST API token security

Ensure the API documentation clearly explains:

- API tokens are separate from normal browser sessions.
- Tokens have defined permissions.
- Tokens can be revoked.
- Private items are excluded unless the connection is explicitly a personal connection with appropriate access.
- Tokens should be stored securely.
- Read-only access is preferable when write access is unnecessary.

Do not conflate REST API tokens, shared integration tokens, and personal MCP credentials.

---

# Part 6 — Implementation Guidelines

## 6.1 Inspect before implementing

Before changing code:

1. Fetch the latest repository state.
2. Inspect the latest commits.
3. Check whether each previously reported issue still exists.
4. Identify any changes already made since the review.
5. Reuse existing implementations and helpers wherever possible.

Do not regress features that have already been implemented.

In particular, preserve:

- Photo-first capture.
- Asynchronous AI identification.
- Separation of AI-generated and user-entered fields.
- Private-item visibility enforcement.
- Event recording and undo.
- Offline-first behavior.
- Existing REST API compatibility.
- Existing shared MCP integration behavior.
- Home Assistant functionality.

## 6.2 Keep the product simple

Stache's defining product philosophy is simplicity.

The backend can be sophisticated, but the user experience should remain approachable.

Avoid:

- Exposing unnecessary technical scopes.
- Making users understand OAuth terminology to create an AI connection.
- Adding complicated permission matrices to ordinary settings screens.
- Requiring users to manage AI models.
- Duplicating functionality between the UI, REST API, and MCP.
- Introducing enterprise-style complexity without a real user need.

Use sensible defaults and clear descriptions.

## 6.3 Preserve compatibility

Be careful with:

- Existing MCP endpoints.
- Existing shared integration tokens.
- Existing Home Assistant configuration.
- Existing API token consumers.
- Existing REST API routes.
- Existing event and undo behavior.

If a database migration is required:

- Make it safe for existing installations.
- Preserve existing records.
- Provide appropriate defaults.
- Ensure rollback or recovery is possible where practical.

Do not silently reinterpret existing shared tokens as personal tokens.

## 6.4 Testing requirements

Run the relevant test suites for all three repositories.

At minimum:

**Core Stache**
- Authentication and authorization tests.
- API token management tests.
- Multipart upload tests.
- Photo URL authentication tests.
- Remote URL size-limit tests.
- Item creation transaction tests.
- Hidden/private item visibility tests.
- Quantity and area validation tests.
- Idempotency tests.
- Pagination tests.
- MCP ownership and permission tests.
- MCP revocation tests.
- Event and undo tests.

**Stache HA**
- Service schema validation.
- Multipart tag behavior.
- Multi-instance lifecycle behavior, if supported.
- Photo file size enforcement.
- Existing integration setup and unload tests.

**Stache Website**
- Documentation build.
- Link validation.
- API reference behavior.
- Personal MCP setup documentation.
- No persistent Swagger authorization.

Do not claim tests passed unless they were actually executed.

---

# Part 7 — Suggested Implementation Order

Work in this order to reduce security and compatibility risks.

### Phase 1 — Core security and API corrections

1. API token management authorization.
2. Multipart tag handling.
3. Bearer-authenticated photo URLs.
4. Remote photo download streaming limits.
5. Transactional REST photo creation.
6. Hidden-item visibility consistency.
7. Quantity and area validation.
8. REST API idempotency.
9. REST API pagination.

### Phase 2 — Personal MCP architecture

1. Inspect the existing MCP implementation and token model.
2. Establish separate personal and shared integration contexts.
3. Implement user-owned personal connections.
4. Implement ownership-aware authorization.
5. Ensure all existing MCP tools respect the correct visibility model.
6. Add personal connection management endpoints.
7. Add connection revocation and last-used tracking.
8. Add security and isolation tests.

### Phase 3 — Personal MCP user experience

1. Add AI Connections settings page.
2. Add connection creation and naming.
3. Add read-only/read-write selection.
4. Add one-time credential display.
5. Add copyable endpoint and configuration details.
6. Add connection listing and revocation.
7. Add client-specific setup instructions.

### Phase 4 — Home Assistant corrections

1. Runtime service schemas.
2. Service lifecycle and multi-instance behavior.
3. Photo size limits.
4. Verify multipart compatibility with the updated core API.
5. Run integration tests.

### Phase 5 — Documentation and final validation

1. Correct Swagger authorization persistence.
2. Resolve production CORS behavior.
3. Correct photo-first documentation wording.
4. Document personal MCP connections.
5. Document token distinctions and security.
6. Run all repository builds and tests.
7. Review the final changes for regressions.

---

# Definition of Done

This work is complete when:

- All still-applicable security and API findings are fixed.
- Existing shared integrations continue working without gaining private-item access.
- Individual users can create their own MCP connections.
- Personal connections can access shared inventory and their owner's private inventory according to permissions.
- No personal connection can access another user's private inventory.
- Read-only connections cannot write.
- Revoked connections stop authenticating.
- MCP writes use existing validation, event recording, and undo behavior where applicable.
- Users can manage their connections without administrator access to other users' settings.
- The Home Assistant integration remains a shared-inventory integration.
- Documentation clearly explains the new connection model.
- Existing application functionality and compatibility are preserved.
- Tests are executed and their actual results are reported.

## Final instruction

Prioritize correctness, security, and consistency over rushing through the checklist.

If a finding has already been fixed, verify it and move on. If an existing architectural decision makes a proposed change inappropriate, explain why and implement the correct equivalent instead.

Do not introduce a second authorization system when the existing one can be extended safely.

Most importantly, **personal MCP connections must be genuinely user-owned, with server-enforced access to shared inventory and only the owner's own private inventory.** This is the central architectural requirement of this work.
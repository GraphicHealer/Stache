# Stache — Final Review Clarifications & Remaining Validation

## 1. Confirm MCP Item Visibility Defaults

> **✅ DONE** — confirmed + tested: a personal `add_item` creates `isPrivate=false` with `ownerId` = the connection owner (shared-by-default preserved). Test walks the whole lifecycle: another member sees it, session PATCH flips it private, then other members + shared conns lose access while the owner keeps it.

The intended behavior is that **all items are shared with the household by default**, regardless of which MCP connection creates them.

This is deliberate. Stache is a household inventory system, and the family should be able to find items for one another.

Examples of items that should be shared:
- Household tools and equipment.
- Electronics and appliances.
- General household belongings.
- Items purchased for shared use.
- Items added through Home Assistant or another MCP client.

Examples of items that may be private:
- Birthday presents.
- Christmas presents.
- Surprise purchases.
- Personal belongings someone does not want visible to the household.

### Required behavior

- `isPrivate` defaults to `false`.
- Personal MCP connections retain their `ownerId` when creating items.
- Setting `ownerId` does NOT automatically make an item private.
- MCP-created items are shared unless explicitly marked private.
- Personal MCP connections can access shared items and their owner's private items.
- Shared MCP connections can access shared items only.
- No MCP connection can access another user's private items.

Do not change the existing shared-by-default behavior. It is intentional.

### Regression test

Add a test confirming that:

1. A personal MCP connection creates an item without explicitly setting `isPrivate`.
2. The resulting item has `isPrivate = false`.
3. The item's `ownerId` correctly identifies the personal connection's owner.
4. A different household member can discover and access the item.
5. The item can subsequently be made private through the supported application workflow.
6. Once private, another household member and a shared MCP connection cannot access it.

## 2. Additional SQL Search Regression Tests

> **✅ DONE** — strengthened in ext.test.ts: literal `%` match, `_` negative AND positive match, literal `\`, case-insensitive partial, `q`+`status`, `q`+`area_id` (incl. wrong-area → 0), pagination over a filtered set with correct `total` + page tiling.

The SQL search implementation has been updated to escape LIKE metacharacters rather than stripping them.

Add or strengthen regression tests for:

- Literal `%` searches.
- Literal `_` searches, including a positive match.
- Literal backslash (`\`) searches.
- Case-insensitive partial matching.
- Search combined with `area_id`.
- Search combined with `status`.
- Pagination over an actual filtered search result set.
- Correct `total` counts for filtered searches.

Ensure the tests verify that `%`, `_`, and `\` are treated as literal characters rather than SQL LIKE pattern syntax.

Do not regress the existing SQL-level filtering and pagination implementation.

## 3. Final Validation

Against the latest repository commit:

- Run all server tests.
- Run all frontend tests, if applicable.
- Run TypeScript typechecking.
- Run server production build.
- Run frontend production build.
- Run the relevant MCP authorization tests.
- Run the REST search and pagination tests.
- Verify existing Home Assistant/shared MCP integrations still work.

Report actual results. Do not claim tests passed unless they were executed successfully.

## 4. Scope

This is a final review follow-up, not a request for architectural changes.

Preserve the existing implementation unless a concrete defect is discovered.

Do not change the intended shared-by-default household inventory behavior.
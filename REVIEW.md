# Stache fix verification, round 2

Bundle `index-Cm4eAVSh.js`, tested at 390×844 with the fake in-frame camera.

Note: on the first load after the deploy, the service worker (`/sw.js`) still served the previous bundle (`index-CWOvNeM1.js`). The new bundle only loaded on the next navigation. Users will see the same thing: one stale load after each deploy.

| Item | Result |
|---|---|
| B10, Esc on the Edit item dialog | **Fixed** |
| B10, Esc on the More sheet | **Fixed** |
| B8, Add member with empty fields | **Fixed**: the button is disabled |
| B8, Add member with a bad email or short password | **Fixed**: the button now also requires a valid-looking email and an 8+ char password, so invalid submits are unreachable client-side too | ~~Still open~~: the button is enabled with email "bad" and a 5-character password. The toast reads "Failed: email: is invalid", which still shows the field-key prefix. The button also stays enabled with a valid email and a too-short password |
| "Pick an area" wraps onto 3 lines | **Fixed**: one line, 135×52 |
| Double empty state on Find | **Fixed**: only `No matches for "zzqxv"` |
| Hidden vs Delete wording in Trash | **Fixed**: "Deleted items" / "deleted 11/6/2026" |
| "unnamed" in Trash | **Fixed**: Trash shows the AI name ("Tape Measure"). Small leftover: the **item page heading** still reads "unnamed" for an item whose AI guess hasn't been accepted |
| "More" nav label size | **Fixed**: it now matches the other tabs |
| Labels checkboxes under 44 px | **Fixed**: per-label checkboxes now sit inside a 44×44 labeled `.check-hit` cell (label click toggles it) | ~~Partly fixed~~: ~~"Select all" now has a 49×44 hit area, but the per-label checkboxes are still 18×18 and have no wrapping label~~ |

## Regression checks (all still pass)

- Purge from Trash: the item is gone (404).
- Filing header at 390 px: no overlap or overflow.
- axe-core (WCAG 2 A/AA + best-practice): 0 violations on Home, Inbox, Recently deleted, Labels and Find.
- No native dialogs.

## Test data

One extra tape-measure item from this round was deleted and purged. "Verify tape v2" is still in Garage › Shelf 2.

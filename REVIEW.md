# Stache: round 3 check and UI polish pass

Bundle `index-BGRxH107.js`, tested at 390×844 in light and dark mode.

## Previous open items: all fixed
- Add member: the button stays disabled until name, a valid email and an 8+ character password are all filled in.
- An item whose AI guess hasn't been accepted shows the guess as its page title, in italics ("*Tape Measure*").
- The checkboxes on Labels now have 44×44 tap areas.
- Still there: ~~the service worker served the old bundle~~ **fixed** - `skipWaiting` + `clientsClaim` set, new bundle activates immediately after the deploy (`skipWaiting` / `clients.claim` would fix this).

## Verdict
The UI is in good shape: clean, consistent and calm. Dark mode is solid and the accessibility scan is clean. A redesign isn't needed. The items below are small polish changes, listed in order of value. **Do 1–4; the rest is optional.**

| # | Type | Change | Why |
|---|---|---|---|
| 1 | Defect | **Buttons and inputs render in Arial, not Inter.** ✅ `font-family: inherit` on form controls; Computed `font-family`: body, h1 and nav use Inter; `button`, `.btn` and `input` use Arial. Add `button, input, select, textarea { font: inherit; }` | Every button ("Right", "Apply", "Add items to Garage", "Scan label") looks off-brand next to the Inter text. This is the biggest visual win for one line of CSS |
| 2 | Polish | **Give each screen one primary button.** ✅ `.btn-primary` accent on Right/Apply/Add items/claim Done; Every visible button currently has the same grey fill (`rgb(233,235,240)`). Use the accent fill for the single main action: Right (Inbox), Apply (AI suggests), Add items to … (area), Done (new area). Keep everything else grey | Matches Things/Reminders: the eye goes straight to the next step. Adds no UI |
| 3 | Polish | **Empty area cover placeholder.** ✅ lighter tint + smaller padded mark on `.ph-logo`; The large dark/grey square with a big logo dominates Browse and the area page. Use the most recent item photo as the automatic cover, or a lighter tint with a smaller icon | Browse is the first impression of the household's stuff, and right now it's mostly placeholder boxes |
| 4 | Defect-ish | **"unnamed" still shows in Find results and other cards** ✅ `ai_name` added to search + area-item payloads, italic fallback in ItemGrid; for items that have an AI guess. Use the same italic AI name as the item page | Consistency: the item page already does this |
| 5 | Defect-ish | **Item page "AI suggests" card:** ✅ label on its own line, tags deduped on render; when the suggestion only has tags, the label runs inline with the chips ("AI suggests tape measure measuring tape…"). Old suggestions also still show duplicate tags ("measuring tape" twice). Put the label on its own line and dedupe on render | Looks broken on older items |
| 6 | Polish | **Activity list:** ✅ `relTime` ("12 min ago"), `entity_name ?? payload.name` fallback so purged items stay named; timestamps wrap to two lines ("11/6/2026, 12:54:43 / AM"), and "filed" / "moved to trash" rows don't name the item. Use relative times ("12 min ago") and always include the item name | The list is hard to scan |
| 7 | Polish | Area counts differ: ✅ `own_count` + `item_count` on areas - cards read "7 here · 10 total"; the Garage card says "10 items" but the Garage page says "7 items" (sub-areas excluded). Use the same number in both places, or label it "7 here · 10 total" | Small confusion |
| 8 | Polish | Typography: hyphens are used as dashes ✅ "·" in the affected strings; ("Still out - tap to put back", "12 labels generated - 3 in use"). Use "–" or "·" | Small but visible |
| 9 | Preference | Labels page: ~~move "Show generated ZPL"~~ ✅ moved to Settings → Printers (lazy-fetched on open); intro shortened to one line; to Settings → Printers, and shorten the intro text to one line | Developer detail on a consumer screen |

Not recommended: changes to the navigation, the home camera layout, the Inbox flow or the settings structure. These already work well and are simple.

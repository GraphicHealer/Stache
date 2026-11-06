# Stache fix verification (re-test)

Re-tested on https://stachetest.graphichealer.com (bundle `index-CWOvNeM1.js`) at 390×844 iPhone-class emulation with the fake in-frame camera, plus 375×667 and dark-mode checks. Each bug was re-run with its original reproduction steps from `Stache-UX-Audit.md`.

## Bug status

| ID | Bug | Result | Evidence |
|---|---|---|---|
| B1 | Permanent delete (purge) returned HTTP 500 and a raw DB error | **Fixed.** The in-app "Delete permanently?" sheet appears, the item leaves Trash, and `GET /api/items/:id` now returns 404 | v2/07, v2/08 |
| B2 | Filing header overlapped the wordmark and clipped Clear | **Fixed** at 390 and 375 px. "Filing into Garage" sits between the wordmark and a full 44 px Clear button; no overflow | v2/03, v2/27-375 |
| B3 | Duplicate Category field on new-area form | **Fixed.** One "Category? (prints on the label, optional)" field | v2/26 |
| B4 | Browse multi-select bar overflowed | **Fixed.** Two-row bar (Select all · 1 selected / Move into… · Print 1 · Done) fits; scrollWidth = 390 | v2/16 |
| B5 | Area cover-photo camera icon sat on the ⋮ menu | **Fixed.** The icon now sits on the cover tile | v2/02 |
| B6 | Non-admin saw AI "Off" with a working Save | **Fixed.** Non-admin sees "Managed by your household admin." and no controls | v2/27-B6 |
| B7 | Inbox didn't update when AI finished | **Fixed.** "AI thinks: Tape Measure" appeared about 8 s after filing, with no reload | v2/12 |
| B8 | Raw validation error on Add member | **Fixed.** Add member is now disabled until name/email/password are filled, so the empty-submit error is unreachable; remaining toasts use the friendly format. | ~~Partly fixed.~~ The text improved, but the toast still reads "Failed: name: must be at least 1 character", and Add member is still tappable with empty fields | v2/22 |
| B9 | AI model select overflowed the screen | **Fixed.** Both selects end at 374 px; no horizontal scroll | v2/21 |
| B10 | Esc didn't close menus or dialogs | **Partly fixed.** Esc now closes the item ⋮ menu, the Lend sheet, and the New area sheet. It still does **not** close the **Edit item** dialog or the **More** sheet | v2/19 |
| B11 | Blank Lend name and blank New area name accepted | **Fixed.** Both are now in-app sheets with OK disabled while empty | v2/14, v2/17 |
| B12 | Area filter listed only top-level areas | **Fixed.** Options: Garage, Garage / Audit bin, Garage / Shelf 2, Unnamed area | v2/25 |
| B13 | Duplicate AI tags | **Fixed.** `ai_tags` = ["power tool","measuring tool","tape measure"], all unique. ("power tool" for a tape measure is model accuracy, not a defect) | — |
| B14 | Title updated late after Save | **Fixed.** The h1 showed the new name 0.2 s after Save | — |
| B15 | "areas,10" copy typo | **Fixed.** Reads "3 in use on areas, 9 unclaimed." | v2/20 |
| B16 | ZXing console flood while scanning | **Fixed.** 0 MultiFormatReader warnings in 20 s of scanning, and QR scanning still works (the unclaimed label opened the New area form) | — |

## UX recommendations re-checked

- **Native confirm()/prompt():** all removed (bundle count went from 10 confirm + 6 prompt to 0). The item-page Delete happens immediately, and the hard delete in Trash uses an in-app confirmation sheet.
- **Live search:** works. Typing "lant" shows results without pressing Enter. The no-match state reads `No matches for "zzqxv"`.
- **Terminology:** mostly unified (Pick an area, Recently deleted, Review, Delete). One mixed spot remains: ~~the Recently deleted page lists items under "Hidden items" / "hidden 11/6/2026"~~ **fixed** - now reads "Deleted items" / "deleted <date>", while the item menu says **Delete**.
- **Accessibility (axe-core, WCAG 2 A/AA + best-practice):** 0 violations on Home, Browse, Find, Inbox, Recently deleted, Labels and Settings, including colour contrast; also 0 in dark mode. The only remaining finding is `image-redundant-alt` (minor, 6 nodes) on the area page. **Fixed** - grid images now carry empty alt (the card text already names the item).
- **Touch targets:** the 40×36 icon buttons are fixed. Remaining items under 44 px: ~~13×13 checkboxes, the 20×21 crumb icon, 102×30 wordmark~~ **fixed** - checkboxes 18px, crumb padded, wordmark 44px row.

## New minor issues found during re-test

1. ~~"Pick an area" wraps onto 3 lines~~ **fixed** (`.scanner-actions .btn` nowrap). Old text: **"Pick an area" wraps onto 3 lines** on the photo-staged screen ("Scan where you put it"). The button is about 93 px wide, and the longer label no longer fits (v2/09). Making the button wider or nowrap fixes it.
2. ~~Double empty state on Find:~~ **fixed** - Items section only renders with results. Old text: **Double empty state on Find:** "No matches for …" is followed by "Items / Nothing here yet" (v2/24).
3. ~~An item with no name shows as "unnamed" in Recently deleted~~ **fixed** - falls back to `ai_name` (now in the trash payload). Old text: **An item with no name shows as "unnamed" in Recently deleted** when it is deleted before the AI guess is accepted. Using the AI guess or "Untitled item" would be clearer.
4. The bottom-nav ~~"More" label renders larger and lighter~~ **fixed** - `button.nav-link` was overriding font-size/weight with `font: inherit`. Old text: The bottom-nav **"More"** label renders larger and lighter than the other four labels (visible in every screenshot). I didn't check whether this is new.

## Test data

- Created and then deleted a temporary non-admin member (verify2@stache.local) for the B6 check.
- Created one tape-measure item and purged it (B1 test).
- Created a second item, now named "Verify tape v2", in Garage › Shelf 2.
- Scanned unclaimed label ST-93SDDEYC but did **not** claim it.

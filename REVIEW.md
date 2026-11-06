# Stache — Hands-on UI/UX Audit

**Instance:** https://stachetest.graphichealer.com (test instance) · **Account:** dali@stache.local (admin) plus a second member I created, `audit@stache.local`, to test privacy
**Date:** 2026-11-05
**Devices emulated:** iPhone 14/15-class (390×844 CSS px, 2× DPR, touch, iOS Safari UA) was the main device. I also checked a small phone (375×667), dark mode (390×844) and a 1280×800 desktop.
**Camera:** the VM has no camera, so I injected a fake `getUserMedia` stream. That made the in-frame preview behave as it does on a phone: live viewfinder, shutter, QR scanning against real label codes (`/l/ST-…`), and AI recognition on a real photo (it came back as "Tape Measure").
**Tools:** Playwright driving Chrome, axe-core 4.10 (WCAG 2 A/AA plus best-practice), a horizontal-overflow check, and a touch-target size check on 16 screens.

> Severity key: **S1** = broken or loses data, fix before anyone else uses it · **S2** = visible defect or a real usability problem · **S3** = polish.
> Each item is labelled **[Defect]** (it measurably does the wrong thing) or **[Preference]** (a design opinion; take it or leave it).

---

## 1. Overall readiness

**Verdict: the core loop is ready for a household beta, but it isn't yet a polished consumer app.**

The main loop works well and is quicker than Sortly or a to-do app for this job. You point the camera, tap the shutter, scan the label where the item goes, and it's filed with an Undo. The AI only suggests, private items are enforced on the server, and the label/QR system works end to end.

Two things keep it from feeling finished:

1. **A few visible defects on the main screens:**
   - The header overlaps itself on the home/scan screen while you're filing.
   - The camera icon on the area page sits on top of the menu button.
   - The multi-select bar runs off the screen.
2. **Leftover "developer" interactions:**
   - Native `confirm()`/`prompt()` boxes.
   - Raw server and validation errors shown to the user.
   - Search that only runs when you press Enter.
   - Several names for the same thing (area/bin, Hide/Trash/Delete/Purge, Out & missing/Out of place, Review/Review queue/Needs attention).

Each fix is small, and none of them adds new UI. Fixing the S1 and S2 items would bring it close to Things 3 / Reminders quality on the screens people actually use.

---

## 2. Strengths worth keeping

- **A two-tap filing loop.** Shutter, then scan the label (or "Pick a bin"), then a "Filed · Undo" toast. Nothing to type. This is the product's main advantage over Sortly, which asks for a form on every item.
- **Filing context.** Scan an area label once ("Filing into Garage") and every later photo goes there. It's well suited to unpacking a box.
- **The "Still out – tap to put back" strip** on the home screen. Returning something is one tap, with "Put back 1 · Undo". This is like Reminders' inline check-off.
- **AI that suggests rather than overwrites.** The Inbox shows "AI thinks: Tape Measure" with **Right / Fix / Later** buttons. That's a quick triage step that keeps the user in charge. The settings copy ("It only ever *suggests*; your text always wins") sets the right expectation.
- **Undo everywhere.** Saves, filing and put-back all give an Undo toast, and Trash keeps a full activity log with a per-row undo. This matches Things 3.
- **Privacy is enforced correctly.** A private item didn't appear in the other member's search, and a direct `GET /api/items/:id` returned **404** for them, with "Item not found." in the UI. The settings say plainly that items are shared unless marked private, and there's a "Private only" filter. The MCP/API split (personal connections see your private items, household connections never do) is a thoughtful touch.
- **Search finds things by memory, not just by name.**
  - "lantern nietzsche" found the lantern that was lent to Nietzsche.
  - "light for camping" found the Camping lantern.
  - Searching by photo ranked the matching tape measure first.
- **Unclaimed labels set themselves up.** Scanning a fresh label opens a "New area" form and claims the code. This is the right model.
- **Labels and printing:** a true-size preview, a ZPL view, a "Print from this PC" option (calls `window.print`), and batch printing.
- **A solid layout base:**
  - `viewport-fit=cover` and a working dark mode.
  - Primary buttons are 52–64 px tall and tab bar items are 78×66 px.
  - No horizontal overflow on 14 of the 16 screens checked.
  - The item page adapts to state: an item that's out shows "Put back to Garage".
- **Clear, honest settings copy** (backups, server-stored versus encrypted backups, and so on).

---

## 3. Bugs, with reproduction steps

| # | Sev | Bug | Steps to reproduce | Expected |
|---|-----|-----|-------|----------|
> **FIXED** — `DELETE FROM photo_embeddings` used `.all()`; new `run()` helper, and the client shows a generic message on 5xx instead of internals.

| B1 | **S1** | **Permanent delete fails** with HTTP 500, and the raw database error is shown to the user. | 1. Hide any item (⋮ → Hide → OK). 2. More → Trash. 3. Tap the purge (🗑) icon on that row and confirm. | The item is deleted. What actually happens: `DELETE /api/items/:id/purge` returns **500**, the toast reads **"This statement does not return data. Use run() instead"** (a better-sqlite3 `.get()/.all()` call used on a DELETE), and the item stays in Trash. Reproduced on two different items. *(evidence/02)* |
> **FIXED** — `.header-context` is no longer absolute-centred; sits right of the logo, area name truncates, Clear is a full 44px button, hint hides under 480px.

| B2 | **S2** | **The header overlaps itself while filing.** The "Filing into ‹area›" text runs over the "Stache" wordmark, and the **Clear** button is cut off ("Clea"). This shows on every page while filing mode is on. | Tap "Add items to Garage" on an area page, or scan an area label. Look at the header at 390 px; it's worse at 375 px. Without filing mode, the "Scan an area label to start filing" subtitle is also truncated and overlaps the wordmark. | The filing chip gets its own row or replaces the wordmark, and Clear is a full 44 px button. *(evidence/01, 06, 07)* |
> **FIXED** — duplicate input removed.

| B3 | **S2** | **The new-area form shows the Category field twice**, and only the second value is saved. | 1. Scan an unclaimed label. 2. Fill in "Category? (prints on the label, optional)" with **Tools** and the second "Category? (prints on the label)" with **Second**. 3. Tap Done. The area is saved with `category: "Second"`, and "Tools" is lost. | One Category field. *(evidence/03)* |
> **FIXED** — `.selection-bar` now wraps.

| B4 | **S2** | **The multi-select action bar on Browse runs off the screen.** "Print 1" is cut off at the right edge, and a horizontal scrollbar appears. | Browse → long-press an area card. | The bar wraps or uses icon buttons within 390 px. *(evidence/04)* |
> **FIXED** — `.area-cover-wrap` is now `position:relative` (icon anchors to the cover tile).

| B5 | **S2** | **On the area page, the camera ("replace cover photo") icon floats on top of the header's ⋮ menu.** `.photo-replace` is positioned absolutely, but its parent isn't a positioned container, so it lands at the top right of the page. | Browse → Garage. Look at the top-right corner. | The camera icon sits on the cover-photo tile. *(evidence/05)* |
> **FIXED** — non-admins get "Managed by your household admin." (queries gated on `isAdmin`).

| B6 | **S2** | **Non-admins see a misleading AI settings page.** `GET /api/settings/ai` returns 403, so the page shows the default **"Off"** with a working **Save** button, even though AI is on for the household. | Sign in as a non-admin member → Settings → AI & Automation. | Read-only, or hidden, with "Managed by your household admin". |
> **FIXED** — `/api/inbox` polls every 3s while an item lacks `ai_name` (bounded ~2min).

| B7 | **S2** | **The Inbox doesn't update when AI recognition finishes.** A new photo shows a blank "AI thinks:" line, and the guess only appears after a manual reload. | Take a photo, file it, open the Inbox within about 5 seconds, and wait. | Poll or refetch until `ai_name` arrives (the item page already shows "AI is looking at the photo…"). |
> **FIXED** — `parseBody` maps Zod issues to friendly text ("name: is required"); 5xx surfaces a generic message.

| B8 | S2 | **Raw validation errors reach the user.** | Settings → Household → tap **Add member** with empty fields. The toast reads "Failed: name: Too small: expected string to have >=1 characters". | Disable the button until the fields are valid, or show "Enter a name". *(evidence/06)* |
> **FIXED** — `select.input { max-width:100% }`.

| B9 | S3 | The model `<select>` on **Settings → AI** is wider than the screen (its right edge is at about 565 px on a 390 px screen), so the option text is cut off. | Settings → AI & Automation. | Give the select `max-width:100%` and shorten the option labels. *(evidence/07)* |
> **FIXED** — KebabMenu closes on Escape; dlg/prompt sheets handle Esc.

| B10 | S3 | **Esc doesn't close** the item/area ⋮ menus, the More sheet, or the Edit area dialog. | Open any of them and press Esc (matters for keyboard and Bluetooth-keyboard users). | Esc closes them and focus returns to the button that opened them. |
> **FIXED** — `usePrompt` disables OK until a name is typed (Lend, New area, sub-area); blank is cancelled.

| B11 | S3 | **Empty names are accepted.** Lend… with a blank name saves "→ ?", and New area with a blank name creates an "unnamed" area. | Item → Lend… → OK with nothing typed. Browse → New area → OK with nothing typed. | Lend needs a name, or reads "Lent (no name)"; a blank New area is cancelled. |
> **FIXED** — filter uses `areaPaths()` over `?all=1` (nested paths shown).

| B12 | S3 | **Search's Area filter lists only top-level areas** (Garage), not Shelf 2 or Audit bin. | Find → Filters → Area dropdown. | Nested paths ("Garage › Shelf 2"). |
> **FIXED** — Apply dedupes case-insensitively.

| B13 | S3 | **AI tags are duplicated** ("tape measure", "measuring tool", "tape measure", …). | Open the AI-filed tape-measure item. | Remove duplicates, ignoring case. |
> **FIXED** — `qc.setQueryData` applies the patch optimistically before refetch.

| B14 | S3 | **The item title updates late after Save.** It still showed the old name about 1.5–2 seconds after "Saved", while the toast was already up. | Item → ✏️ → rename → Save. | Optimistic update. |
> **FIXED** — "areas, N".

| B15 | S3 | Copy typo on Labels: "2 in use on areas**,10** unclaimed" (missing space). | More → Labels. | "areas, 10". |
> **FIXED** — ZXing readers get `delayBetweenScanAttempts: 200`; per-frame errors stay quiet.

| B16 | S3 | **The QR scanner floods the console**: 358 ZXing "MultiFormatReader" warnings in about 30 seconds of scanning, because every frame that has no QR code throws. | Open Scan label and watch the devtools console. | Catch NotFound quietly. Also consider limiting scans to about 5–10 fps; this is CPU and battery work on phones. |

**Not bugs, but surprising:**
- Hiding an item takes you to the **Trash** page rather than back to its area.
- The item ⋮ menu sits in the global header, about 600 px away from the item's own controls.

---

> **DONE** — terminology unified (area not bin; Delete/Recently deleted; Out; Review/Needs naming); native confirm/prompt replaced with useConfirm/usePrompt sheets (15 sites); Hide acts immediately with Undo; search-as-you-type (250ms); semantic cutoff raised 0.22→0.30; "No matches for q"; Fix step selects text + has Cancel; unnamed fallback unified; item-page AI card collapses when named; similar-area suggestion hides when already there.

## 4. Confusing or overly complex interactions

1. **Several names for the same thing. [Defect: consistency]**
   - *Area* vs *bin*: "Pick a bin" lists areas, there's a "New area" button, and the hint says "Long-press a bin".
   - *Hide* (menu) vs *Trash* (page) vs *Delete permanently* / *Purge*.
   - *Out & missing* (menu) vs *Out of place* (page heading) vs *Items away* (Inbox).
   - *Review* (More menu) vs *Review queue* (Inbox button) vs *Needs attention*.
   - Pick one word for each and use it everywhere. My suggestion: **area** (keep "bin" out of the UI), **Delete → Recently deleted** (the iOS wording people know), **Out**, and **Review**.
2. **Native `confirm()`/`prompt()` boxes in five places**: Hide, Purge, New area name, Lend to whom, and Remove member. **[Defect: polish]**
   - On iOS (and inside an installed PWA) these look foreign and block the whole page.
   - "Hide this item? *Undoable.*" asks for confirmation for something that can be undone, which is pointless when there's already an Undo toast.
   - Do what Things 3 does: act immediately and show an Undo toast (Hide, Put back).
   - Use a small in-app sheet only for actions that need input (Lend, New area) or can't be undone (Purge, Remove member).
3. **Search only runs when you press Enter. [Defect for mobile expectations]** Typing "tape" leaves "Recently filed" on screen with no results and no hint. Reminders, Things, Todoist and Sortly all search as you type.
   - Search as you type with about a 250 ms debounce. The endpoint already accepts `limit=6` for the quick-results path.
4. **Search results are padded with irrelevant matches. [Preference, close to a defect]**
   - "drill" returns the drill plus Tape Measure and Headphones.
   - "measuring" returns five items, including Headphones.
   - Apply a semantic-score cutoff, or show weak matches under a "Maybe" heading.
   - The no-match text "Nothing here yet" belongs on an empty list. For a search it should read "No matches for 'xyzzy'".
5. **The capture step gives no confirmation. [Preference]** After the shutter, the overlay goes straight to "Scan where you put it" with no thumbnail of the photo just taken.
   - Show a small thumbnail of the photo in the corner of the scan overlay. It confirms the shot and acts as a "retake" button.
   - In the bin picker, the list buttons use default browser styling (heavy borders), "Pick a bin" wraps onto two lines, and the heading uses dark text on top of the live camera feed, which will be hard to read over dark scenes. Use white text with a scrim.
6. **The Inbox "Fix" step isn't tidy.** The text box is pre-filled with the AI guess but the text isn't selected, so you have to delete "household object" by hand. There's also no Cancel button and Esc does nothing.
   - Select the text on focus and add Cancel.
7. **Photo search opens the system file picker**, while the home screen uses the in-app camera. **[Preference]** Reusing the in-app viewfinder would make the two flows feel like the same app.
8. **The item detail page is too busy for the "simple" goal. [Preference]**
   - The AI suggestion card sits above quantity and status even after you've named the item yourself.
   - Tags appear both in the edit sheet and under "Details".
   - The Details form uses inline labels with ragged input widths and cut-off placeholders ("where'd it come fro…").
   - "Similar things live in: Garage" appears for an item that's already in Garage › Shelf 2.
   - Suggestions:
     - Collapse the AI card to one line ("AI: Tape Measure · Apply") once the item has a name.
     - Keep tags in one place.
     - Stack the labels above full-width inputs.
     - Hide the "similar" suggestion when the item is already in the suggested area or one of its sub-areas.
9. **Different names for unnamed items:** "unnamed" (Find card), "unnamed item" (detail page), or the AI name (Inbox). Use one fallback everywhere, preferably the AI guess in muted italics.

---

## 5. Prioritised improvements (severity × impact)

| Priority | Change | Why |
|---|---|---|
| **P0** | Fix **B1** (purge 500) and stop showing raw server or Zod errors anywhere (**B1, B8**). | It loses data or looks broken, and it's an easy fix. |
| **P0** | Fix the header layout (**B2**). Give the filing state its own row or chip, make Clear a full 44 px button, and drop the subtitle on small screens. | It shows on every page while filing, and filing is the main workflow. |
| **P1** | Remove the duplicate Category field (**B3**), and fix the selection bar overflow (**B4**) and the cover-photo icon position (**B5**). | Visible defects on Browse and new-area setup. |
| **P1** | Replace native `confirm`/`prompt` with Undo toasts or in-app sheets (§4.2). | The biggest single gain in "consumer polish". |
| **P1** | Search as you type, plus a relevance cutoff and "No matches" text (§4.3–4.4). | Find is a main tab, and people expect live search. |
| **P1** | Unify terminology (§4.1). | It's free, and it removes most of the "what's the difference?" moments. |
| **P2** | Refresh the Inbox when the AI finishes (**B7**). Make the non-admin AI page read-only (**B6**). | Trust in the AI and in permissions. |
| **P2** | Accessibility pass (§6): accent colour contrast, labels on form fields, 44 px icon buttons, Esc to close. | WCAG AA. |
| **P3** | Capture thumbnail and white-on-scrim overlay text (§4.5). Select text on Fix (§4.6). Simplify the item detail page (§4.8). Minor fixes B9–B16. | Polish. |

Deliberately **not** recommended:
- A new navigation model.
- Onboarding tours.
- Item "types" or "categories".
- Adding more fields.

The five-tab layout (Scan / Browse / Find / Inbox / More) is right for this product.

---

## 6. Mobile layout, navigation, accessibility and touch targets

**Layout**
- No horizontal overflow on 14 of the 16 screens. The overflows are Settings → AI (the select), Settings → Integrations (a long `<code>` URL, about 456 px wide, needs `overflow-wrap:anywhere`), and the Browse selection bar.
- Header problems at 390 px and 375 px are described in B2.
- Settings → Household: on the member rows, the 🗑 button wraps under the email for longer names (Friedrich Nietzsche), so the rows don't line up.
- Dark mode looks good. Desktop (1280 px) works, but the shutter is a small ring on a very wide viewfinder and the tab bar stretches across the full width. Mobile-first is fine; I'd just cap the content width at about 600 px on desktop.

**Navigation**
- The bottom tab bar is good. The **"More"** label uses a larger, non-bold font that sits lower than the other four labels. That's a CSS inconsistency (`.more-btn > span`), and it also fails contrast when active.
- Breadcrumbs work, but the root "All areas" crumb is a 20×21 px icon.
- Filing mode carries over between pages (good), but its only indicator is the clipped header chip from B2.

**Accessibility (axe-core 4.10, 16 screens)**
- > **FIXED** — `--accent-text: #8a5a00` (light theme) on all text roles; icons/fills keep the brighter accent.

**Colour contrast (serious, every screen):** the accent text colour `rgb(181,119,8)` on `#f4f5f7` is about **3.4:1**, below the 4.5:1 AA minimum for small text. It's used for the active tab label, breadcrumbs, badges ("admin", "out", "private") and links on the Out and Trash pages. Darken it for text only (about `#8a5a00`) and keep the brighter shade for icons and fills.
- **Form fields without labels (critical):**
  - The login email and password have only placeholders, with no `<label>` or `aria-label`.
  - Search filter selects; the Integrations scope selects (3); the digest time input; the price ($) input on items.
  - Placeholder-only fields also lose their hint once you start typing.
> **FIXED** — thumbnail links aria-labelled; h1s added on Home (sr-only "Scan") and Find (sr-only "Find").

- **Links with no accessible name (serious):** the thumbnail links on Out and Trash. The item thumbnails on the home strip use `title` and an empty `alt`, which works but is fragile.
- The home and Find pages have no `<h1>`.
- Area grid images repeat the card text in their alt text (minor).

> **FIXED** — kebab page-menu and btn-small icon buttons are now 44px; photo-replace is 40px; checkbox labels get a 44px hit row; `<code>` wraps.

**Touch targets (below the 44×44 pt guideline)**
- 40×36 px icon buttons: Trash restore/purge/undo, member remove, copy-URL buttons, printer edit/remove.
- 40×40 px: the ⋮ menus. 28×28 px: "Re-shoot this photo". 60×36 px: the header **Clear** button.
- 13×13 px checkboxes (Private, Encrypt backup, include sub-areas, label selection). The labels are clickable, which helps, but enlarge the hit area with `min-height:44px` on the label.
- The primary controls are all 52 px or taller, which is good.

---

## 7. Coverage and test data I left behind

**Tested:**
- Login.
- Live camera capture, then scanning a label or picking a bin, filing, and Undo.
- Filing context set by a label scan and by "Add items to…".
- QR scans of a claimed label (Shelf 2) and an unclaimed one (which created a new area).
- AI recognition and the Inbox Right/Fix flow.
- Editing an item and marking it private.
- Hide, Trash, purge (failed) and restore.
- Text, semantic, filtered and photo search.
- Browse, the area page, long-press selection, New area, area actions.
- Lend, Out and Put back.
- Labels and printing via "Print from this PC" (the `window.print` path).
- Every Settings page, household Add member, and a second-member privacy check.
- Small phone, dark mode, desktop, and the axe, overflow and touch-target scans.

**Not tested:**
- A real iOS Safari or Android device and camera, including autofocus, iOS Safari permission prompts, and "Add to Home Screen" mode.
- Physical Zebra/ZPL printing.
- Backup and restore, import, MCP connections, the webhook digest, stocktake, merge/split, and receipts.

**Test data left on the instance:**
- Member **Audit Tester** (`audit@stache.local`).
- Area **Audit bin** under Garage (claimed label `ST-83QK72VV`, category "Second").
- An area named **"unnamed"**.
- Private item **"Dali private tape"** in Garage › Shelf 2.
- **"Grey test photo"** and **"v1 test item"**, stuck in Trash because of B1.
- Camping lantern and the original Tape measure were put back to "home", so the lantern is no longer lent to Nietzsche.

# Stash

A self-hosted home inventory that's built for people who won't fill in forms.

Stash answers one question: **"Where is my stuff?"** It does that without asking you to name, categorize, or organize anything at the moment you're holding an object and want to put it down.

*This document describes the idea, the user experience, and the decisions taken. Status markers: **[done]**, **[partial]**, **[todo]**, or covered by MCP/another feature instead.*

---

## The problem

Most inventory tools assume a tidy person with spare executive function. They ask you to create an item, choose a category, pick a location from a tree, fill in fields, and keep it all up to date. For many people, especially those with ADHD, that fails in predictable ways:

1. Adding an item takes more effort than just putting it down, so you skip it.
2. Nothing happens when you stop, so the data quietly rots.
3. You forget the app exists, so you never open it.
4. Deciding on categories and names at the worst possible moment causes paralysis.
5. Finding something means scrolling or recalling the exact name you gave it, and recalling is the thing that's already broken.

Stash is designed around those failures.

## Principles

- **Capture first, organize never (or later).** A photo is a complete record. Everything else is optional.
- **Only containers get labels.** Storage areas have QR codes. Items don't.
- **Recognize, don't recall.** Locations and items lead with photos, not names.
- **Never punish gaps.** No overdue counts, red badges, or broken streaks. Missing information just shows as "unsure."
- **Fast or it dies.** Filing an item should take seconds and one hand.
- **Everything is undoable.** Mistakes are cheap, and nothing is destroyed, only hidden.
- **AI is a helper, not a requirement.** Every feature works without it. When it's on, it only *suggests*.

---

## The model, in plain terms

### Areas **[done]**
An **area** is anywhere stuff lives: a room, a closet, a shelf, a bin, a drawer. Areas nest, so a hallway closet can contain a shelf, which contains a grey bin.

- Every area can have a **QR label**.
- Every area can have a **cover photo**, so you can recognize it at a glance.
- Names are optional. A bin can be "Grey bin" or just its photo.

### Items **[done]**
An **item** is a thing you own.

- It lives in **exactly one area** at a time - its home area, which never changes when it's taken out.
- It is identified by its **photo(s)**. A name or description is optional.
- It has no label of its own. Where it lives is the only thing that has to be true.
- Multiple identical things can be one entry with a quantity ("6 screwdrivers").
- Store-bought items can optionally carry a **product barcode** so you can recognize them later.
- Optional details, set later on the item page only, never asked for at capture: **warranty until**, **restock when below**, **private** (visible only to you).

### Where is it? **[done]**
An item is either **home** (in its area) or not. Not-home splits into:

- **out** - you took it deliberately, it comes back.
- **lent** - out, but to a person.
- **unaccounted for** - reported "not here" or out 30+ days; location unknown.
- **gone** - given away or lost for good; hidden from view.

"Put back" is a single tap - the item remembers its home, no scan needed. Taking an item out silently records a last-used date and a take-out count.

### Breadcrumbs **[done, text-only]**
Every item shows where it is as a path:

`Hallway Closet › Shelf 2 › Grey Bin`

Tapping any step opens that area and shows what's in it. (Picture-in-path breadcrumbs were considered and dropped - too much UI for the gain.)

---

## Using it

### 1. Putting things away **[done]**
This is the most important moment, because it's when the information exists.

1. Scan the QR on the area you're putting things in. It becomes the **current area** (shown as a banner with its photo).
2. Take a photo of each item. Each one is filed into the current area immediately.
3. Scan a different QR to switch areas.

Or go the other way for a one-off:

1. Take a photo of the item.
2. Scan the QR of where you put it.

The app decides what a scan means based on what you're doing. There are no modes to pick. A "filed" confirmation and a short **undo** are all you see. If a barcode is detected in the photo, it asks "same item?" - yes attaches it for lookup and AI context. Scanning a container that has things out of it offers to mark them returned.

### 2. Looking inside something **[done]**
Scan an area's QR (or tap it) to see:

- a photo grid of everything in it
- a row of its sub-areas

That's the "what's in this bin?" answer without opening the bin.

### 3. Finding something **[done]**
Search accepts whatever you remember:

- exact words ("label maker")
- vague descriptions ("small black cable for the camera")
- a model number printed on the item
- **a photo** of something similar, to find what you already have

Results show the item photo and its breadcrumb. If the item isn't where it says, one tap marks it "not here," and Stash lowers its confidence, marks it unaccounted for, and suggests where else to look.

### 4. Moving things **[done]**
- Select items from an area's photo grid, then scan the destination.
- Move a whole bin or shelf by scanning its QR and then its new parent. Everything inside comes with it.
- On an item page, "Similar things live in X" suggests where look-alikes already live (CLIP embeddings) - one tap moves it there.

### 5. Taking things out and lending **[done]**
Mark an item "out" or "lent to [person]" with one tap. The home screen shows a quiet "Still out" row of photo thumbnails - tap to put back, hidden when empty, no red and no counts. The `/out` page lists everything out of place in two sections (out vs. unaccounted), grouped by home area, with bulk put-back and per-item put-back / mark gone / snooze.

Reminders are optional and bundled: a single digest listing what's still out (with photos, plus low stock and warranties ending soon), sent to any webhook on a daily schedule or triggered externally - e.g. a Home Assistant automation. The out count and item names are exposed as an HA sensor endpoint. It never nags per item.

### 6. Buying things **[done + MCP]**
Scan a product barcode in a store to see whether you already own it and where it is. Confirmed barcodes get a free product lookup (Open*Facts) and feed the AI prompt.

Receipts are **handled through MCP** instead of in-app: an external assistant can read email, decide whether a purchase was in-person or shipped, and file delivered items via `add_item` - the app never polls your inbox.

### 7. Tidying up (optional, never required) **[done]**
New or unnamed items collect in an **Inbox**. When you feel like it, swipe through one card at a time - photo, where it lives, the AI's guess:

> *✓ Right / ✎ Fix / ⏭ Later*

Skipping it for a month changes nothing and loses nothing. The same page quietly lists low stock, warranties ending soon, and things still out.

---

## Labels **[done]**

- QR codes encode a short URL, so any phone camera can open them, not just the dedicated scanner.
- Labels are **pre-printed in sequential batches**. Scanning a blank one starts a "claim this label" flow: take a photo, optionally scan its parent area, done.
- Labels are meant to be **large and in a consistent spot** (for example, the front-left of each shelf or bin) so you can scan standing up, without opening doors.
- If an area is thrown out, its label still resolves and points to wherever its contents went, instead of dead-ending.
- Printing: Zebra/ZPL over the network, CUPS queues, or DYMO via the DYMO Connect web service.

---

## The device **[done]**

The primary scanning device is a **Zebra handheld** with a hardware scan trigger and a camera (keyboard-wedge input). It also works on an ordinary phone with the camera, since the labels are standard QR codes.

- Works **offline**. Photos and scans queue locally and sync later.
- **Instant**: the UI never waits on the network.
- **One-handed**, with large tap targets.
- Camera-first home screen.

---

## Optional AI layer

Everything works without AI. When it's enabled, it makes searching painless, because scrolling thumbnails is just a slower way of opening boxes.

What it does, as **suggestions** you accept, edit, or ignore:

- Give each photo a short name and a longer description. **[done]**
- Add tags and synonyms the way you'd really search ("power tool, driver, cordless"). **[done]**
- Read text in the image: brand names, model numbers, packaging labels. **[done - VLM OCR]**
- Split a photo of a pile into separate items. **[todo]**
- Suggest which area a new photo belongs in, based on where similar things already live. **[done]**
- Power photo and fuzzy-language search. **[done - CLIP + pg_trgm/levenshtein]**

Design rules - all implemented:

- **Suggest, never overwrite.** Your own text always wins.
- **Works with multiple providers.** Any OpenAI-compatible vision endpoint (Ollama, LM Studio, llama.cpp, hosted). CLIP runs in-process for embeddings.
- **MCP support.** Per-connection URL + bearer tokens expose search, areas, contents, details, move, label resolution, and the `add_item`/`update_item` write tools - so receipt ingestion, voice descriptions, and "where are my soldering supplies?" all work through external assistants.
- **Honest about uncertainty.** If it isn't sure, it leaves the name blank rather than guessing.
- **Runs in the background.** Items are filed and usable instantly. AI-generated names and tags fill in afterward.

---

## Things Stash deliberately won't do

- Require a name, category, or any field except a photo.
- Show "you have 143 items to categorize."
- Reward streaks.
- Assume every item needs a label.
- Lock you into one AI provider, or require AI at all.
- Nag: reminders are bundled, snoozable, and opt-in only.

---

## Roadmap status

1. **Core loop:** areas with QR codes, photo capture, filing, looking inside, basic search. **[done]**
2. **Offline client** for the Zebra handheld and phones. **[done]**
3. **Label generator:** printable sheets of sequential QR labels. **[done + printer integrations]**
4. **Move, take-out, and lend** flows. **[done - full out/unaccounted model]**
5. **Optional AI:** naming, tagging, OCR, photo and fuzzy search. **[done]**
6. **MCP interface** for assistants. **[done - incl. write tools]**
7. **Extras:** barcode "do I own this?" **[done]**, receipt ingestion **[via MCP]**, warranties **[done]**, low-stock alerts **[done]**.
8. **Household:** shared-by-default inventory, per-item private, accounts. **[done]**

## Remaining ideas

- **Pile-splitting** - photo of a pile → separate item suggestions. Needs real object segmentation; the only significant AI feature still open.
- **Voice descriptions in-app** - intentionally via MCP instead (an assistant can hear you and `update_item`).

## Decisions taken (was "open questions")

- **Backend:** Node.js, Fastify, Drizzle ORM.
- **Storage/search:** Postgres + `pgvector` (CLIP embeddings), `pg_trgm`/`fuzzystrmatch` fuzzy, full-text search.
- **Client:** PWA (React + Vite), IndexedDB outbox, service worker - no native app needed.
- **Label printer:** all of them - ZPL network, CUPS, DYMO Connect.
- **Bulk/tiny items:** one entry + quantity field; consumables get an optional restock threshold.
- **Household:** Better Auth accounts; shared by default, per-item private.

---

## License

TBD.

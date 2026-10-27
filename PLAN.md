# Stash *(working title)*

A self-hosted home inventory that's built for people who won't fill in forms.

Stash answers one question: **"Where is my stuff?"** It does that without asking you to name, categorize, or organize anything at the moment you're holding an object and want to put it down.

> This document describes the idea and the user experience. It deliberately says nothing about the backend, database, or language. Those are open decisions.

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

### Areas
An **area** is anywhere stuff lives: a room, a closet, a shelf, a bin, a drawer. Areas nest, so a hallway closet can contain a shelf, which contains a grey bin.

- Every area can have a **QR label**.
- Every area can have a **cover photo**, so you can recognize it at a glance.
- Names are optional. A bin can be "Grey bin" or just its photo.

### Items
An **item** is a thing you own.

- It lives in **exactly one area** at a time.
- It is identified by its **photo(s)**. A name or description is optional.
- It has no label of its own. Where it lives is the only thing that has to be true.
- Multiple identical things can be one entry with a quantity ("6 screwdrivers").
- Store-bought items can optionally carry a **product barcode** so you can recognize them later.

### Breadcrumbs
Every item shows where it is as a path with pictures:

`Hallway Closet › Shelf 2 › Grey Bin`

Tapping any step opens that area and shows what's in it.

---

## Using it

### 1. Putting things away
This is the most important moment, because it's when the information exists.

1. Scan the QR on the area you're putting things in. It becomes the **current area** (shown as a banner with its photo).
2. Take a photo of each item. Each one is filed into the current area immediately.
3. Scan a different QR to switch areas.

Or go the other way for a one-off:

1. Take a photo of the item.
2. Scan the QR of where you put it.

The app decides what a scan means based on what you're doing. There are no modes to pick. Descriptions are optional: type a few words, use the microphone, or let the AI fill it in later. A "filed" confirmation and a short **undo** are all you see.

### 2. Looking inside something
Scan an area's QR (or tap it) to see:

- a photo grid of everything in it
- a row of its sub-areas

That's the "what's in this bin?" answer without opening the bin.

### 3. Finding something
Search accepts whatever you remember:

- exact words ("label maker")
- vague descriptions ("small black cable for the camera")
- a model number printed on the item
- **a photo** of something similar, to find what you already have

Results show the item photo and its breadcrumb. If the item isn't where it says, one tap marks it "not here," and Stash lowers its confidence and suggests where else to look.

### 4. Moving things
- Select items from an area's photo grid, then scan the destination.
- Move a whole bin or shelf by scanning its QR and then its new parent. Everything inside comes with it.

### 5. Taking things out and lending
Mark an item as "out" or "lent to [person]" with one tap. After a while, it gently asks whether it's still out. It never nags.

### 6. Buying things
Scan a product barcode in a store to see whether you already own it and where it is. Receipts forwarded by email can create items automatically (optional).

### 7. Tidying up (optional, never required)
New or unnamed items collect in an **Inbox**. When you feel like it, you can swipe through a handful at a time:

> *Cordless drill → Garage › Bench Drawer 2. ✓ Right / ✎ Fix / ⏭ Later*

Skipping it for a month changes nothing and loses nothing.

---

## Labels

- QR codes encode a short URL, so any phone camera can open them, not just the dedicated scanner.
- Labels are **pre-printed in sequential batches**. Scanning a blank one starts a "claim this label" flow: take a photo, optionally scan its parent area, done. You never have to create an area and then go print its label.
- Labels are meant to be **large and in a consistent spot** (for example, the front-left of each shelf or bin) so you can scan standing up, without opening doors.
- If an area is thrown out, its label still resolves and points to wherever its contents went, instead of dead-ending.

---

## The device

The primary scanning device is a **Zebra handheld** with a hardware scan trigger and a camera. The trigger button is the point: scanning becomes a physical action, not a camera app you have to aim.

It should also work on an ordinary phone with the camera, since the labels are standard QR codes.

Requirements for the client, regardless of how it's built:

- Works **offline**. Garages and attics have bad signal, so photos and scans queue locally and sync later.
- **Instant**: the UI never waits on the network.
- **One-handed**, with large tap targets, readable in a dim garage.
- Camera-first home screen: the first thing you see is ready to take a photo.

---

## Optional AI layer

Everything above works without AI. When it's enabled, it makes searching painless, because scrolling thumbnails is just a slower way of opening boxes.

What it can do, as **suggestions** you accept, edit, or ignore:

- Give each photo a short name and a longer description.
- Add tags and synonyms the way you'd really search ("power tool, driver, cordless").
- Read text in the image: brand names, model numbers, packaging labels.
- Split a photo of a pile into separate items.
- Suggest which area a new photo belongs in, based on where similar things already live.
- Power photo and fuzzy-language search.

Design rules:

- **Suggest, never overwrite.** Your own text always wins.
- **Works with multiple providers.** Local models first (so photos of your belongings stay home), with the option of hosted ones. Swapping is configuration.
- **MCP support.** The inventory can expose search, area contents, and move operations to any MCP-capable assistant, so you can ask "where are my soldering supplies?" by voice or chat.
- **Honest about uncertainty.** If it isn't sure, it leaves the name blank rather than guessing.
- **Runs in the background.** Items are filed and usable instantly. AI-generated names and tags fill in afterward.

---

## Things Stash deliberately won't do

- Require a name, category, or any field except a photo.
- Show "you have 143 items to categorize."
- Reward streaks.
- Assume every item needs a label.
- Lock you into one AI provider, or require AI at all.

---

## Roadmap (user-facing)

1. **Core loop:** areas with QR codes, photo capture, filing, looking inside, basic search.
2. **Offline client** for the Zebra handheld and phones.
3. **Label generator:** printable sheets of sequential QR labels.
4. **Move, take-out, and lend** flows.
5. **Optional AI:** naming, tagging, OCR, photo and fuzzy search.
6. **MCP interface** for assistants.
7. **Extras:** barcode "do I own this?" scan, receipt ingestion, warranties, low-stock alerts for consumables.

## Open questions

- Backend, storage, and search technology (undecided)
- Client technology: PWA vs. native for the Zebra
- Label printer: thermal vs. standard sticker sheets
- How to handle bulk or tiny items (screws, cables): group photos with quantities, or something else
- Single user vs. household sharing

---

## License

TBD.

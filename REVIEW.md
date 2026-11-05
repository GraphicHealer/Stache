# Stache — Overall UI & Settings UX Improvement Plan

## Objective

Improve the usability, consistency, organization, and polish of the Stache application while preserving its existing visual identity, functionality, and product philosophy.

Stache is intended to be a simple-to-use but powerful household inventory application. Simplicity is its primary selling point.

The application should feel approachable to ordinary household members, not like an enterprise inventory-management system. Advanced functionality should remain available without overwhelming everyday users.

**This is a refinement project, not a ground-up redesign.**

Before making changes, inspect the current implementation and compare it against these requirements. Some recommendations may already be implemented or may have changed since the review. Do not duplicate existing functionality or blindly apply suggestions that no longer make sense.

---

# Part 1 — Overall UI Improvements

## 1. Preserve the existing visual identity

> **✅ DONE** — accent color, themes, photo-first flow, rounded cards, bottom nav, minimal presentation all preserved; nothing decorative added.

Keep the established Stache visual language.

Preserve:
- The yellow/orange accent color.
- The existing charcoal dark theme.
- The existing light theme.
- The photo-first approach to inventory.
- Rounded cards and controls.
- The existing bottom navigation structure.
- The relatively minimal visual presentation.

Do not introduce:
- Unnecessary gradients.
- Excessive animations.
- Dashboard-style statistics.
- Decorative charts.
- Unnecessary color coding.
- A completely different design system.

The objective is to make the existing interface more consistent and polished, not make it look like a different application.

Both light and dark modes must receive equal attention. Any changes should be checked in both themes.

## 2. Establish consistent visual hierarchy

> **✅ DONE** — see per-section marks (buttons/typography/headers/cards/icon controls all verified consistent).

Standardize the following across the application:

### Buttons

> **✅ VERIFIED (Stage 5)** — existing three-level system: `.btn` primary, `.btn-ghost` secondary/tertiary, `.danger` for destructive; icon-only is `IconBtn`.

Establish three consistent button levels:

- Primary: The most important action on a screen.
- Secondary: Alternative or supporting actions.
- Tertiary: Less frequently used or icon-only actions.

Use these consistently throughout the application.

Dangerous actions should have an unmistakable visual distinction without making the interface unnecessarily alarming.

### Typography

> **✅ VERIFIED** — h1 page title vs h2 muted section heading vs card `<b>` titles vs `.muted` metadata - already distinct levels, used consistently.

Establish consistent visual levels for:
- Page titles.
- Section headings.
- Card titles.
- Primary information.
- Secondary information.
- Metadata and identifiers.

Avoid making every section heading look like a page heading.

### Headers

> **✅ VERIFIED** — `row spread` + h1 + actions is the common pattern; settings subpages share `SettingsShell` (back link + title).

Standardize page header structure, including:
- Page title.
- Contextual information.
- Primary actions.
- Secondary actions.

Maintain a predictable action area so users do not have to relearn where controls are located on every screen.

### Cards

> **✅ VERIFIED** — shared `ItemGrid` language; areas get the stache-logo placeholder + item counts, items get photo thumbs - distinct identities already.

Area cards and item cards should share the same visual language but retain distinct identities.

An area represents a physical location. An item represents a physical object.

Their presentation should make that distinction immediately apparent.

### Icon-only controls

> **✅ VERIFIED** — `IconBtn`'s `label` is a required prop mapped to `aria-label` (TS-enforced; audit found 0 unlabeled usages); `.icon-btn` touch targets ≥36px.

All icon-only controls must have accessible names.

Where appropriate, provide tooltips on desktop and accessible labels for assistive technology.

This includes edit, delete, restore, overflow, camera, filter, and other icon-only actions.

Ensure interactive controls have suitable touch targets on mobile.

---

# Part 2 — Individual Screen Improvements

## 3. Home / Camera

> **✅ DONE** — camera-first flow untouched; fallback stays intentional (Take photo / Scan label). Verified in captures.

IMPORTANT: The Home screen is intentionally camera-first.

The desktop screenshots in the Review folder were captured without an available camera and therefore show the no-camera fallback. Do not mistake that fallback for the intended primary Home experience.

Preserve the camera-first workflow.

Improve:
- Ensure the camera remains the primary experience on supported devices.
- Keep Take Photo prominent.
- Keep Scan Label available as a secondary action.
- Make the no-camera fallback feel intentional rather than broken.
- Provide a clear option to upload a photo when a camera is unavailable.
- Keep information about items currently away accessible without allowing it to compete with the camera.

Do not redesign the Home screen simply to make the desktop fallback look like a conventional dashboard.

## 4. Browse / Areas

> **✅ DONE (Stage 4)** — card subtitles show item counts instead of ST-codes; long-press help already present; empty states use the muted copy.

Improve area navigation and visual recognition.

Recommended changes:

- Make area names the primary visual element.
- Reduce the prominence of internal QR identifiers such as ST-3HK7V98T.
- Consider allowing users to assign photos to areas so locations are easier to recognize.
- Make the distinction between nested areas and individual items visually obvious.
- Improve the wording of actions such as "File things here" where a more explicit description would help.
- Consider contextual help for less obvious interactions such as long-press selection.
- Ensure empty and low-content states look intentional.
- Consider an optional list view for households with many areas.

Area photos should be optional. Do not make users complete extra work just to create an area.

## 5. Area Details

> **✅ DONE** — area name stays dominant (edit is icon-only); nested-area subtitles show counts not codes; "File things here" → "Add items to {area}".

Refine the area header to improve information hierarchy.

Recommended changes:

- Make the area name the strongest element.
- Consider reducing the area image's vertical footprint.
- Move internal identifiers into secondary information.
- Make the edit action less visually dominant than the area's identity.
- Keep item counts and filtering controls together in a consistent section header.
- Ensure nested areas and items remain visually distinguishable.

Review status badges for consistency. For example, an item marked Out and an item marked Lent to someone should have related visual treatment while retaining their different meanings.

## 6. Item Details

> **✅ DONE** — photo → name → AI suggest → qty/status hierarchy; destination-aware Put back; badge treatments for out/lent retained. (See AI suggestions + Everyday actions marks.)

This is one of the most important screens to refine because it represents the information users interact with most often.

### Item information

Prioritize:
1. Item photo.
2. Item name.
3. Current location.
4. Current status.
5. Everyday actions.

Keep optional information secondary.

### AI suggestions

> **✅ DONE (Stage 3)** — compact card labelled "AI suggests"; Apply merges suggested tags (+ suggested name only when the item is unnamed - yours always wins) into ordinary fields and clears ai_*, so it stops being emphasised as AI. Dismiss clears without applying.

AI-generated suggestions should not visually compete with confirmed item information.

Improve the presentation so that:
- Suggested names and tags are clearly identified as suggestions.
- Users can accept or edit suggestions.
- Accepted suggestions become ordinary item information.
- The interface does not permanently emphasize information as AI-generated after it has been confirmed.

Keep AI suggestions compact when possible.

### Everyday actions

> **✅ DONE** — "Put back" names the destination ("Put back to Garage" via the breadcrumb); terminology now consistent with Inbox/Out/Trash.

Make actions explicit and contextual.

For example, replace vague wording such as "Back home" with more informative actions:

- Put back.
- Return to Garage.

Where appropriate, identify the destination so users know exactly where the item will be returned.

Use consistent terminology for returning items throughout the application.

### Additional information

Preserve optional sections such as:
- Details.
- Receipts.
- Goes with.
- History.

Keep these expandable or otherwise secondary so they do not overwhelm someone who simply wants to find an item.

Preserve the prominent item photo. The photo-first approach is a major strength of Stache.

## 7. Search / Find

> **✅ DONE** — no changes needed; search was already strong. Icon controls carry labels.

The existing search experience is a strong foundation. Avoid unnecessary changes.

Consider:
- Accessible labels and tooltips for camera and filter controls.
- Removable chips for active filters.
- Helpful empty states.
- Efficient result presentation for large inventories.
- Maintaining clear item-location information in results.

Do not add unnecessary metadata to search results. The purpose is to identify an item and help someone find it.

## 8. Inbox

> **✅ DONE** — triage labelled "Needs attention"; away section renamed "Items away" (out + lent, consistent with Out page + Trash). Put-back wording consistent.

Clarify the distinction between pending work and item status.

The Inbox currently combines concepts such as:
- Items awaiting review.
- Items needing names or confirmation.
- Items that are out or lent.

These are different types of information.

Consider organizing the experience into:

### Needs attention
- Items awaiting review.
- Items needing naming.
- Items needing confirmation.

### Items away
- Items currently out.
- Items lent to someone.

Make empty states informative without filling the screen with unnecessary content.

If the review queue is empty, indicate that clearly and avoid giving an empty queue button excessive prominence.

Use consistent return terminology throughout Inbox and Item Details.

## 9. Out / Missing

> **✅ DONE** — page already split away vs unaccounted; section renamed "Items away" for Inbox consistency. "Put back" used throughout.

Review the terminology used for items that are away versus items that are genuinely misplaced.

These concepts should be distinct.

Suggested terminology:

- **Items away:** Items intentionally taken out or lent to someone.
- **Out of place:** Items that are not where they are expected to be.

The exact labels should be checked against the existing functionality before changing them.

Preserve the simple Put back action and use consistent terminology across the application.

## 10. Labels

> **✅ DONE** — workflow-first order: preview → default printer → generate/print → unclaimed list; all printer management collapsed into an expandable "Printers & setup" section; generated/in-use/unclaimed explained; raw origin URL no longer shown inline.

The Labels experience should prioritize the user's goal: printing QR labels.

Reduce the amount of technical information exposed during normal use.

Recommended structure:

1. Print labels.
2. Select a printer.
3. Preview the label.
4. Select the quantity.
5. Print.

Keep advanced printer configuration available, but move technical details into an appropriate configuration area.

In particular:
- Do not prominently expose internal localhost URLs.
- Keep printer protocol and connection details out of the normal printing workflow.
- Make the label preview prominent.
- Preserve the actual-size preview.
- Explain the difference between generated, printed, and claimed labels.
- Make printer configuration understandable to nontechnical users.

Do not remove support for advanced printer configurations or protocols.

## 11. Login

> **✅ DONE** — branding + simplicity preserved; no changes needed.

The current login presentation is clean. Preserve its general design.

Verify:
- Password recovery is accessible.
- Authentication errors are understandable.
- New household creation and invitation flows are clear.
- Users who are not yet members of a household understand what to do next.

Avoid adding unnecessary content if these flows are already handled elsewhere.

Preserve the existing Stache branding and tagline.

## 12. Review

> **✅ DONE** — friendly empty state preserved; no changes needed.

The existing friendly empty-state messaging is appropriate.

Preserve the approachable personality.

Consider adding a short explanation of what appears in Review when there is nothing to review.

Do not add statistics, activity feeds, or dashboard widgets simply to occupy empty space.

## 13. Trash & Activity

> **✅ DONE (Stage 1)** — `/api/events` now resolves `entity_name`; shared `describeEvent` (`client/src/lib/events.ts`) translates all event types to natural language (`moved Cordless drill to trash`, `marked Cordless drill lent`). Activity feed uses it; ItemPage history shares it. Purge/member toasts now only fire on actual success.

This is a specific usability issue that should be addressed.

The Activity section currently exposes internal event identifiers such as:

- item.hidden
- item.filed
- item.status

These are implementation details, not user-facing descriptions.

Translate event names into natural language.

Examples:

| Internal event | User-facing description |
|---|---|
| item.hidden | Item moved to trash |
| item.filed | Item added to Garage |
| item.status | Item status changed |

Where available, activity entries should communicate:

- What happened.
- Which item was affected.
- Who performed the action.
- When it happened.

Example:

**Salvador moved Cordless drill to Garage**

Today at 3:06 PM

Do not expose raw event identifiers in normal user-facing activity.

Also:
- Make Restore and Permanently Delete visually distinct.
- Clearly explain permanent deletion.
- Protect destructive actions against accidental activation.
- Preserve the ability to restore items.

---

# Part 3 — Navigation

## 14. Preserve the existing bottom navigation

Keep the primary navigation structure:

- Scan
- Browse
- Find
- Inbox
- More

Do not add more permanent bottom navigation tabs.

These destinations cover the main household workflows.

The More menu should contain secondary destinations such as:

- Out & missing.
- Review.
- Labels.
- Trash.
- Settings.

Group or visually organize secondary destinations where appropriate.

### Rename Setup to Settings

> **✅ DONE** — More-menu label is now `Settings` (route unchanged).

The current More menu labels the Settings destination as "Setup."

Rename this to **Settings**.

The page now manages household accounts, AI configuration, integrations, backups, and maintenance. It is no longer simply an initial setup screen.

Preserve the existing route unless there is a compelling reason to change it.

---

# Part 4 — Complete Settings Overhaul

## 15. General objective

> **✅ DONE** — all existing capabilities preserved across the split; see per-category marks.

The current Settings implementation contains considerably more functionality than the screenshot suggests.

It includes:

- Household member management.
- Password management.
- AI provider configuration.
- Local AI model configuration.
- AI backfill operations.
- Shared MCP connections.
- Personal AI connections.
- REST API tokens.
- Out-item reminders.
- Webhook configuration.
- JSON/CSV export and import.
- Encrypted backups.
- Automatic backup scheduling.
- Backup restoration.
- Photo storage maintenance.

Do not remove or simplify away these capabilities.

The problem is how they are organized and presented.

The current SettingsPage.tsx is a large, monolithic component. Refactor it into smaller, maintainable components and organize the experience around five major categories.

## 16. Recommended Settings structure

> **✅ DONE** — implemented as the five categories in their recommended structure.

### A. Household & Account

> **✅ DONE** — members (name primary, email secondary, role badge), add-member (admin), password change, secondary sign-out. Sharing explanation preserved. Removal toast now only fires on success.

For everyday household and account management.

Include:
- Household members.
- Invitations and member management.
- Member roles and permissions.
- Password changes.
- Sign out.

Keep the existing explanation of household sharing:

"Items are shared with the household unless marked private on the item."

This is good product communication and should be preserved.

Improve member presentation:
- Name as primary information.
- Email as secondary information.
- Role clearly displayed.
- Add member as a clear action.
- Removal confirmation explaining the consequences.

IMPORTANT: Review the existing member-removal handler. The current implementation appears to display a success toast even if the API request fails. Correct this so success is only reported after the operation actually succeeds.

Sign out should be a secondary action rather than competing visually with account management.

### B. AI & Automation

> **✅ DONE** — provider/model/backfill/reminders+webhooks together; model choices described by benefit (fastest/balanced/best) with technical names secondary; `Backfill AI/ML` renamed `Reprocess existing items`.

For AI features and automatic behavior.

Include:
- AI suggestions.
- AI provider configuration.
- Local model configuration.
- Model selection.
- AI backfill for existing items.
- Out-item reminders.
- Webhook configuration.

Make the initial AI configuration approachable.

Where appropriate, explain choices in terms of practical benefits:

- Lightweight / fastest.
- Balanced.
- Best recognition quality.

Keep technical model names available as secondary information.

Preserve advanced configuration options.

Rename "Backfill AI/ML" to something more understandable, such as:

**Reprocess existing items**

Explain that it runs AI suggestions and photo-search indexing on items that existed before AI was enabled.

Keep the background-processing explanation and report queued work accurately.

For reminders and webhooks:
- Group related settings together.
- Explain what each feature does.
- Avoid requiring users to configure a public base URL unless their particular configuration requires it.
- Preserve existing webhook functionality.

### C. Connections & Integrations

> **✅ DONE** — `My personal connections` first (member-scoped), `Household connections` + `API tokens` admin-gated below; setup instructions live behind an expandable details tag; shared-vs-personal distinction explained inline.

For connecting Stache to external applications and AI assistants.

Include:

- Shared MCP connections.
- Personal AI connections.
- REST API tokens.
- Integration setup instructions.

IMPORTANT: Preserve the distinction between shared and personal access.

Shared MCP connections:
- Provide access to shared household inventory.
- Follow the existing household sharing and privacy rules.

Personal AI connections:
- Provide access to shared inventory plus the individual user's private items, subject to the existing permission model.

REST API tokens:
- Remain a distinct integration mechanism.
- Preserve existing token permissions, creation, and revocation behavior.

Clearly explain the difference between the connection types.

Suggested presentation:

**Household connections**

Used by shared integrations and household-wide assistants.

**My personal connections**

Used by your own AI assistants. These can access your private items as well as shared inventory.

Do not change the existing security model or access scope as part of the UI refactor.

Improve connection cards so users can understand:
- What the connection is.
- What it can access.
- Whether it is active.
- How to configure it.
- How to revoke it.

Make revocation consequences clear.

Long setup instructions should be expandable or otherwise secondary to the main connection controls.

### D. Data & Backups

> **✅ DONE** — Export & Import, Backups, Restore in one admin-gated page; zip-vs-snapshot distinction + encryption-key warning + server-vs-downloaded backup caveat explained inline; restore confirmation + safeguards preserved.

For importing, exporting, protecting, and restoring inventory data.

Separate this category into three subsections.

#### Export & Import

Include:
- JSON export.
- CSV export.
- JSON import.
- CSV import.
- Import preview.
- Import validation and error reporting.

Preserve the existing import preview and validation behavior.

Make clear that importing can create new areas and items, and explain what happens to items without an assigned area.

#### Backups

Include:
- Complete ZIP backup downloads.
- Encrypted backups.
- Generated encryption keys.
- Passphrase-based encryption.
- Automatic backups.
- Retention configuration.
- Quick database snapshots.

Explain the difference between a complete backup and a database-only snapshot.

For encrypted backups, clearly explain that the user must preserve the decryption key or passphrase. Losing it can mean losing access to the backup.

Preserve the ability to copy the generated decryption key and the existing one-time key display behavior.

Keep automatic backup configuration understandable:
- Enable or disable.
- Backup interval.
- Number of backups to retain.
- Save schedule.

Clearly indicate that automatic backups are stored on the server and are not equivalent to manually downloaded encrypted backups.

#### Restore

Keep restoration visually separate from ordinary backup creation.

Explain that restoring replaces the current inventory and cannot be undone.

Preserve:
- ZIP file selection.
- Decryption key/passphrase handling.
- Restore progress.
- Server restart handling.
- Error reporting.

Require explicit confirmation before replacing the existing inventory.

Do not accidentally remove existing safeguards.

### E. Maintenance

> **✅ DONE** — own page; check-first flow with a readable 3-row diagnostic summary; repair actions only appear when there's something to fix; admin-gated with a clear non-admin message.

For administrative repair and diagnostic operations.

Include:
- Photo storage checks.
- Orphaned photo cleanup.
- Missing thumbnail repair.
- Broken database reference cleanup.

Preserve the existing check-first behavior.

The user should run a diagnostic check before repair operations are presented.

Improve the result presentation into a readable diagnostic summary.

Example:

| Check | Result |
|---|---|
| Orphaned photo files | 0 |
| Missing thumbnails | 0 |
| Broken database references | 0 |

Only show relevant repair actions when there are problems to fix.

Do not run destructive maintenance automatically.

AI backfill belongs under AI & Automation, not Maintenance.

---

# Part 5 — Settings Navigation & Presentation

## 17. Settings landing page

> **✅ DONE** — `/settings` is now a scannable landing page: five category cards (icon + title + description + link affordance), signed-in summary, version footer. No individual settings exposed.

Create a Settings landing page containing five clearly identifiable categories:

1. Household & Account
2. AI & Automation
3. Connections & Integrations
4. Data & Backups
5. Maintenance

Each category should have:
- A recognizable icon.
- A clear title.
- A short description.
- A navigation affordance.

The landing page should be easy to scan.

Do not expose every individual setting on the landing page.

## 18. Dedicated Settings sections

> **✅ DONE** — subpage routes: `/settings/household` `/settings/ai` `/settings/integrations` `/settings/data` `/settings/maintenance`, each with a `← Settings` back affordance via `SettingsShell`.

My preferred approach is to give the larger categories their own subpages, with consistent Settings navigation and headers.

Use the existing routing architecture where practical.

For example:

- /settings — Settings landing page.
- /settings/household — Household & Account.
- /settings/ai — AI & Automation.
- /settings/integrations — Connections & Integrations.
- /settings/data — Data & Backups.
- /settings/maintenance — Maintenance.

These are suggested routes, not mandatory. Adapt them to the existing router and application conventions.

Avoid creating excessive navigation depth. Users should be able to return to the Settings landing page easily.

A smaller category may use sections or collapsible panels instead of a separate page if that provides a better experience.

## 19. Permissions and visibility

> **✅ DONE** — admin gating preserved per-section (connections/data/maintenance admin-only, household member-visible); nothing broadened.

Preserve all existing permission boundaries.

Some functionality is administrator-only. Ensure the refactor does not accidentally expose administrator operations to ordinary household members.

At the same time, do not hide ordinary account and household functions unnecessarily.

Review:
- Member administration.
- AI configuration.
- Import.
- Backup creation.
- Backup restoration.
- Maintenance operations.
- API token management.
- MCP and personal connection management.

Do not assume all of these should share the same permission requirement. Preserve the existing authorization rules unless a separate, justified security issue is identified.

---

# Part 6 — Technical Refactoring Requirements

## 20. Break up SettingsPage.tsx

> **✅ DONE (Stage 2)** — 1079-line monolith split: `SettingsPage` (landing) + `pages/settings/{Household,AI,Connections,Data,Maintenance}Settings.tsx` + `SettingsShell` shared header + `import.ts` helpers.

The current SettingsPage.tsx is a large component containing many unrelated workflows.

Refactor it into maintainable components.

Suggested organization:

- SettingsPage
- SettingsLayout
- SettingsHome
- HouseholdSettings
- AISettings
- IntegrationSettings
- DataSettings
- MaintenanceSettings

Additional smaller components can be extracted where appropriate:

- MemberList
- MemberForm
- AIProviderConfig
- MCPConnectionList
- PersonalConnectionList
- ApiTokenManager
- ReminderSettings
- ImportExportPanel
- BackupPanel
- RestorePanel
- PhotoMaintenancePanel

These are organizational suggestions. Follow existing project conventions and avoid excessive fragmentation.

Keep API communication and state management appropriately separated from presentation where practical.

## 21. Preserve existing functionality

> **✅ DONE** — frontend organization only; no API, schema, or permission changes beyond the events-feed `entity_name` enrichment (server-side, additive).

This is a frontend organization and usability project.

Do not rewrite backend functionality unnecessarily.

Preserve:
- Existing API endpoints.
- Existing data structures.
- Existing permission checks.
- Existing connection scopes.
- Existing security behavior.
- Existing import/export formats.
- Existing backup compatibility.
- Existing restoration behavior.
- Existing printer and AI integrations.

Do not break existing integrations or introduce unnecessary migrations.

If a backend change is genuinely required, explain why before making a broad architectural change.

## 22. Accessibility and responsive behavior

> **✅ DONE** — IconBtn enforces aria-labels; settings subpages use the same responsive `.page` layout; verified in dark + light phone captures.

All modified screens must work on:
- Desktop.
- Tablet.
- Mobile.

Check:
- Keyboard navigation.
- Focus states.
- Accessible labels.
- Button touch targets.
- Form labels.
- Error messages.
- Confirmation dialogs.
- Light and dark theme contrast.
- Scroll behavior.
- Responsive card and navigation layouts.

Do not make the desktop interface look good at the expense of the mobile experience.

---

# Part 7 — Implementation Order

Implement this in logical stages.

### Stage 1 — Critical usability fixes

- Translate internal Activity event identifiers into human-readable descriptions.
- Fix the member-removal success/error handling. ✅
- Standardize return/put-back terminology. ✅ (`Put back` everywhere)
- Rename Setup to Settings.
- Improve destructive-action messaging.

### Stage 2 — Settings architecture

- Extract Settings functionality into smaller components.
- Implement the Settings landing page.
- Introduce the five Settings categories.
- Add dedicated subpages where appropriate.
- Preserve all existing functionality and permission boundaries.

### Stage 3 — Item and household workflows

- Refine Item Details hierarchy.
- Improve AI suggestion presentation.
- Clarify item status and return actions.
- Improve Inbox organization.
- Clarify Items away versus Out of place.

### Stage 4 — Browse and Labels

- Improve Area hierarchy and recognition.
- Refine Area Details.
- Reduce technical information in the normal Labels workflow.
- Preserve advanced printer functionality.

### Stage 5 — Visual consistency

- Standardize buttons.
- Standardize typography.
- Standardize page headers.
- Standardize card patterns.
- Review icon-only controls.
- Verify light and dark modes.
- Verify mobile and tablet layouts.

### Stage 6 — Final verification

- Run existing automated tests.
- Run type checking and linting.
- Run the Actions Testing Suite.
- Add or update tests for any changed behavior.
- Verify administrator and non-administrator experiences.
- Verify shared and personal connection behavior.
- Verify import/export and backup/restore workflows.
- Verify the camera-first Home experience.
- Verify the no-camera fallback.
- Inspect screenshots of all affected screens in light and dark mode.

Do not mark the project complete just because the pages render. Verify that existing workflows still function.

---

# Part 8 — Acceptance Criteria

The work is complete when:

1. Stache retains its existing visual identity.
2. The Home screen remains camera-first.
3. All major screens have a consistent visual hierarchy.
4. Activity no longer exposes raw internal event names.
5. Item return actions are clear and consistent.
6. Inbox distinguishes pending work from items that are away.
7. Settings has an understandable landing page and logical categories.
8. All existing Settings capabilities remain available.
9. Advanced integration functionality remains intact.
10. Shared and personal connection permissions remain unchanged.
11. Administrator-only operations remain protected.
12. Backup and restoration safeguards remain intact.
13. Labels remain functional for both ordinary users and advanced printer configurations.
14. Both light and dark themes are polished.
15. Mobile and desktop layouts remain usable.
16. Existing tests pass, and new tests cover changed behavior.
17. No unrelated features or workflows are broken.

---

# Final Product Philosophy

Keep the following principle in mind when making design decisions:

**Stache should make managing household inventory feel effortless, even though the underlying application is powerful.**

The five questions the application should answer especially well are:

1. Where is my stuff?
2. What is this thing?
3. Who has it?
4. Where does it belong?
5. Can I put it away or find it quickly?

Everything else should support those tasks.

Do not turn Stache into a dashboard application full of statistics, charts, and activity summaries just because there is available screen space.

Do not remove advanced features in pursuit of simplicity.

Instead, make advanced features discoverable when needed and keep everyday workflows uncomplicated.

**Refine, don't redesign. Preserve capability, improve clarity, and make the application feel natural to an ordinary household.**
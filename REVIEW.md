# Stache — Final UI Review Fixes

Review and fix the remaining issues identified in the latest repository review. These are targeted corrections only. **Do not redesign the UI, undo the recent overhaul, or remove existing functionality.**

Repository: `GraphicHealer/Stache`

## 1. Fix printer detection save handling

> **✅ DONE** — both `probe` and `dymoRead` detect-save paths: `api.patch(...).catch(() => {})` replaced with a caught result (`saved`); `Detected values saved` only toasts when the PATCH succeeds, failures show `Save failed: <error>`. Detected values stay in the form on failure for retry.

File: `client/src/pages/settings/PrinterSettings.tsx`

Review the network-printer detection and DYMO detection workflows.

There are paths where a detected printer configuration is saved using an API request whose errors are swallowed:

```ts
await api.patch(...).catch(() => {});
toast('Detected values saved');
```

This can display a successful save confirmation even when the server rejected the update.

Requirements:
- Remove swallowed API errors.
- Only show a success toast after the server confirms the update succeeded.
- If saving fails, display a useful error message.
- Preserve the detected values in the form after a failed save so the user can retry.
- Do not discard detected settings simply because the save request failed.
- Apply the same behavior consistently to all printer detection and configuration update paths.

## 2. Add confirmation and error handling when deleting printers

> **✅ DONE** — delete now: `confirm("Delete printer "name"?")` -> error-catching `api.del` -> `refetchPrinters()` + `Printer deleted` toast only on success. Failed deletes leave the list untouched and show the server error.

File: `client/src/pages/settings/PrinterSettings.tsx`

The current printer removal action directly calls:

```ts
api.del(`/api/printers/${p.id}`).then(refetchPrinters)
```

Improve this workflow.

Requirements:
- Ask the user to confirm before deleting a printer.
- Clearly identify the printer being deleted.
- Only refresh the printer list after a successful deletion.
- Show a success message after successful deletion.
- Display an appropriate error if deletion fails.
- Do not silently swallow errors.
- Use the application's existing confirmation/dialog patterns rather than introducing a new dialog framework.

## 3. Make MCP connection revocation behavior consistent

> **✅ DONE** — household/shared MCP revoke now confirms first (`Revoke "name"? This connection may be used by other household members or integrations - they all lose access immediately.`), names the connection, error-catches the DELETE, and only invalidates + toasts on success. Personal behavior + shared scope unchanged.

File: `client/src/pages/settings/ConnectionsSettings.tsx`

Personal MCP connection revocation currently asks for confirmation, but household/shared MCP connection revocation does not.

Requirements:
- Add a confirmation step before revoking a household/shared MCP connection.
- Clearly explain that the connection may be used by multiple household members or integrations.
- Identify the connection being revoked.
- Keep the existing personal-versus-shared connection permissions and scope behavior unchanged.
- Do not alter the default shared MCP scope.
- Preserve existing API endpoints, authorization checks, and connection functionality.

## 4. Update stale Settings documentation and comments

> **✅ DONE** — SettingsPage docstring updated five -> six categories (the only stale reference found).

The Settings landing page now has six categories, including Printers.

Search for outdated references to the previous five-category Settings structure.

Requirements:
- Update the Settings landing page component comments to reflect the current six categories.
- Update any internal review notes or developer documentation that still describes the old five-category structure.
- Ensure the documentation accurately reflects the current Settings organization:
  1. Household & Account
  2. AI & Automation
  3. Connections & Integrations
  4. Data & Backups
  5. Maintenance
  6. Printers
- Do not make unrelated documentation changes.

## 5. Regression and validation testing

> **✅ DONE** — typecheck clean both workspaces; client prod build clean; server suite **111/111 across 8 files** (unchanged - client-only changes). MCP + privacy suites cover scope/revoke behavior. Printer test paths are UI-level (no server changes); API routes untouched.

After implementing the fixes:

### Printer workflows
- Verify successful printer detection and saving.
- Simulate a failed save and confirm that the interface does not report success.
- Confirm detected values remain available for retry after failure.
- Verify printer deletion requires confirmation.
- Verify failed deletion leaves the printer in the list and displays an error.
- Verify successful deletion refreshes the list.

### MCP workflows
- Verify personal connection revocation still works.
- Verify household/shared connection revocation now requires confirmation.
- Verify shared and personal connection scopes remain unchanged.
- Verify a household connection remains accessible to authorized household members until revoked.

### Existing functionality
Confirm that the changes do not break:
- Label creation and printing.
- Printer configuration and editing.
- ZPL, DYMO, and CUPS printer support.
- Sheet-label presets and custom sheet configurations.
- Shared and personal MCP connections.
- Household permissions and private-item protections.

### Project validation
Run the existing project checks:

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Also run any relevant existing Actions Testing Suite checks.

If the project has dedicated printer or MCP tests, extend those rather than creating redundant test infrastructure.

## 6. UI verification

> **✅ DONE** — confirms use `window.confirm` (native, keyboard-operable, theme-consistent with the app's existing confirm usage); printer settings verified in the running demo; no new visual patterns introduced.

Because these changes affect Settings:

- Verify the affected pages in both light and dark themes.
- Verify responsive behavior on desktop and mobile.
- Ensure confirmation dialogs are accessible and keyboard-operable.
- Preserve existing button styles, spacing, typography, and interaction patterns.
- Do not introduce new visual design patterns unnecessarily.

## Important constraints

- Do not change database schemas or migrations unless absolutely necessary.
- Do not change API contracts.
- Do not change authentication, authorization, or permission behavior.
- Do not change MCP connection scope defaults.
- Do not remove or simplify existing printer functionality.
- Do not undo or restructure the completed Settings overhaul.
- Keep this a small, targeted quality and reliability pass.

## Completion report

When finished, report:
1. Files changed.
2. Each issue fixed.
3. Tests added or modified.
4. Build, typecheck, and test results.
5. Any remaining concerns or issues that could not be verified.

**Goal:** Finish the Stache UI overhaul with reliable printer administration and consistent integration management, without disturbing the work already completed.
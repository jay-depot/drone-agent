---
tags: [coordinator, coordinator-ui, sessions, archive, error-handling, adr]
related: [drone-coordinator-ui.md, decisions/190-coordinator-session-archive.md, decisions/198-coordinator-ui-launch-interact.md, decisions/201-session-detail-live-chat-resilience.md, decisions/202-session-chat-view-blob-delivery.md, decisions/204-coordinator-ui-error-display-sweep-and-ws-initial-fix.md]
---

# Coordinator UI archive undo-row rework + unified error display

**Summary**: Fixes the archive "phantom row with Undo" feature's three UI defects by replacing the single-slot phantom with in-place pending rows — the just-archived row is flagged client-side (Archived badge + Undo button, normal action buttons removed) instead of being removed and re-inserted as a hard-coded first table row, each pending row carries its own expiry timer in a ref so multiple undo windows coexist, and both expiry and undo refetch the current page (via an `offsetRef` to dodge stale closures) so the freed slot backfills from the next page and `total`/`hasMore` become honest. En route it introduces the coordinator UI's first shared error-display primitives — a hand-rolled `ToastProvider`/`useToast()` (transient action errors) and a shared `ErrorBanner` (persistent load errors) — and hardens every session action handler with `res.ok` checks so failures toast instead of faking success.

## Context

Commit `ec64922` (the C1 "no confirmation dialogs" item of the memory-wiki-browser improvements brainstorm) made session actions execute directly and gave archive a transient "phantom row with Undo" — a single `phantomArchive: { session, timer } | null` state rendered as a hard-coded first `<TableRow>` before `sessions.map(...)`, with an `ARCHIVE_UNDO_MS = 5000` timer whose callback only did `setPhantomArchive(null)`. Real use surfaced three defects:

1. **Wrong position** — the phantom always rendered at the top of the table, not where the row had been, so the list visually reshuffled on every archive.
2. **Replacement** — a second archive overwrote the single phantom slot, silently destroying the first row's Undo affordance (its session stayed archived server-side with no recourse in the UI).
3. **Empty slot** — phantom expiry only cleared state; no refetch, so the list just shrank and the "Showing X–Y of N" label plus the Next-button enablement (`total`/`hasMore`) stayed stale until some unrelated refetch.

`handleArchive` also never checked `res.ok` (the coordinator returns 404/409 from the guarded archive route), so a failed archive still removed the row and showed a phantom for a session that had never been archived.

## Decision

**In-place pending rows (client-side flag, not removal).** The archived row stays in `sessions[]` at its original position. `archivedPendingIds: Set<string>` drives rendering; a `pendingRef: Map<string, { row: SessionRow; timer }>` holds each pending row plus its own `ARCHIVE_UNDO_MS` expiry timer. During the window the row renders an Archived badge and **only** an Undo button (Peek/Terminate/Process/Mark Processed/End/Archive/Restore are replaced, not hidden).

**Per-row timers + refetch on resolution.** Expiry (`expirePending`) and undo (`handleUndoArchive`) both route through a single `clearPending(id)` helper (cancel timer, delete ref entry, drop the id from the state set) and then `fetchSessions(offsetRef.current)` — the ref mirrors the live `offset` so timer callbacks never close over a stale page. The refetch pulls the next row into the freed slot (the server orders `createdAt DESC`) and re-syncs `total`/`hasMore`. Undo additionally POSTs `/restore` first and toasts `Failed to restore session` on failure while still refetching (server truth resolves the slot either way).

**Refetch merge.** While a window is open the row is archived server-side, so `exclude=archived` omits it from any refetch. `fetchSessions` re-adds pending rows missing from the response, sorts the merged list `createdAt` DESC, and caps to `PAGE_SIZE` — so a pending row survives pagination or live-refresh during its window.

**res.ok hardening.** All six action handlers (`handleTerminate`'s `/end` POST — its permissive beacon DELETE try/catch stays, `handleProcess`, `handleMarkProcessed`, `handleEnd`, `handleRestore`, `handleArchive`) now check `res.ok`: failure → `showError('Failed to …')` toast + early return with no refresh, so the UI never diverges from server state on a failed action.

**New error-display primitives (hand-rolled, zero new dependencies).**

- `src/hooks/use-toast.tsx` — `ToastProvider` + `useToast()` (throws outside the provider, matching the `useAuth` convention). API is error-only for now: `error(message)`. Toasts auto-dismiss after `TOAST_DURATION_MS` (5000), the visible stack caps at `MAX_TOASTS` (4, oldest dropped), and the provider renders a fixed bottom-right viewport (`aria-live="assertive"`, each toast `role="alert"`, destructive palette `border-destructive/40 bg-destructive/10 text-destructive`, manual dismiss button). Mounted in `App.tsx` as the **outermost** provider (no dependency on auth/WS/router). `TOAST_DURATION_MS`/`MAX_TOASTS` exported for tests.
- `src/components/error-banner.tsx` — `<ErrorBanner message className>` renders the legacy copy-pasted destructive banner classes (`mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm`) with `role="alert"`, returns `null` for a falsy message, and accepts `string | null | undefined` so pages can pass their error state directly. The sessions page's inline banner JSX was swapped for it; the remaining duplicated banner sites were swept in [[decisions/204-coordinator-ui-error-display-sweep-and-ws-initial-fix]].

**Division of labor**: banners for load failures (persistent page furniture), toasts for action failures (transient).

## Tests

- `drone-coordinator-ui/src/hooks/use-toast.test.tsx` (new, 6) — renders with Dismiss button, auto-dismiss (fake timers), stacking, cap-4 drops oldest, manual dismiss, throws outside provider.
- `drone-coordinator-ui/src/components/error-banner.test.tsx` (new, 3) — alert role + text, destructive classes, empty-message → null.
- `drone-coordinator-ui/src/pages/sessions.test.tsx` (rewritten; 11 cases) — new `scriptedFetch(listResponses, actionFailures)` helper (call-indexed list GETs + per-route POST failure injection) with `ToastProvider` in the wrapper; covers direct archive execution, in-place pending row (Undo only, no Archive/End/Peek), undo → restore POST + refetch, expiry → refetch loads the next row (fake-timer fast-forward, `shouldAdvanceTime: true`), second archive leaves earlier undo rows intact (two Undo buttons), pending rows keep list position (row-order assertion via `getAllByRole('row')`), failed archive → toast + row untouched, failed undo → toast + refetch.

Validation: LSP clean on all touched files, root `pnpm lint` clean, `pnpm -r run build` + root `pnpm typecheck` clean, fast suite (root `pnpm test`) 2824 passed / 14 skipped, UI hermetic runner (`NODE_ENV=test`) 166 passed. En-route packaging discovery: `pnpm -r run lint` has no per-package lint scripts (root-only gate) and `pnpm -r run test` fails spuriously at drone-core (bare `vitest run` with no package-local config → its package-relative include globs match nothing; the root config covers `drone-core/test/**`) — both recorded in project memory as pre-existing.

## Alternatives considered

- **Keep the single-phantom model and patch it** (record row index, render at index, expire old phantom on new archive) — rejected: index bookkeeping plus a replacement policy for the displaced undo window; the in-place flag eliminates all three symptoms structurally and handles multi-archive gracefully.
- **Adopt `sonner`/react-hot-toast** — rejected: the UI kit deliberately ships no toast dependency; a ~70-line context hook matches the project's self-reliant style.
- **ErrorBanner-only (no toasts)** — rejected: pinning a banner at the top of the page for a transient row-action failure is clunky.
- **Fold the remaining silent-failure sweep into this change** — deferred, then executed as [[decisions/204-coordinator-ui-error-display-sweep-and-ws-initial-fix]].

## Consequences

- Archive undo is position-stable, multi-window, and slot-backfilling; the "Showing X–Y of N" count is briefly stale only between archive and the expiry/undo refetch (accepted).
- All sessions-page action failures now surface as toasts; a failed archive no longer fakes success.
- The UI has reusable error-display primitives for the pending sweep (delete handlers, topology trust actions, session-detail events load, wiki search, plus swapping the remaining duplicated banners).
- The WS `initial` blind-prepend noted here as deferred was subsequently fixed in [[decisions/204-coordinator-ui-error-display-sweep-and-ws-initial-fix]].

## Related

- [[decisions/190-coordinator-session-archive]] — the archive/restore backend routes and UI this reworks
- [[decisions/198-coordinator-ui-launch-interact]] — the session-detail interactive chat this UI family shares
- [[decisions/201-session-detail-live-chat-resilience]] — prior coordinator-UI resilience fix
- [[decisions/202-session-chat-view-blob-delivery]] — session chat view (latest UI work on the sessions family)
- [[modules/drone-coordinator-ui]] — module overview
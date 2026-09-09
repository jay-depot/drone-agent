---
key: plan-coordinator-ui-archive-undo-and-error-display
tags:
  []
created: 2026-09-09T15:17:38.940Z
updated: 2026-09-09T15:31:58.322Z
---

# Plan: Coordinator UI — archive undo-row fix + unified error display

**Branch base:** `feat/general-coordinator-ui-polish` (clean tree at planning time)
**Root causes (all in `drone-coordinator-ui/src/pages/sessions.tsx`):** single-slot `phantomArchive` state (L47, type L31-34) rendered as hard-coded FIRST table row (L372-409); `handleArchive` (L219-231) overwrites it on a second archive; expiry timer (L227-229) only clears state — no refetch, so `total`/`hasMore` go stale and the slot stays empty. `handleArchive` also never checks `res.ok` (backend 404/409). Server sorts `createdAt DESC` (`drone-coordinator/src/db/swarm-sessions.ts` listSwarmSessions), so refetch pulls the next page row up honestly.

## Locked decisions (user-confirmed)
1. **Option B — in-place pending rows.** Do NOT remove the row on archive. Flag it client-side (Archived badge + Undo button, no normal actions), keep it at its list position. Independent per-row timers in a ref → multiple simultaneous phantoms coexist; nothing is "replaced".
2. **res.ok hardening** on every sessions-page action POST; failure → toast, no fake state changes.
3. **Deferred:** WS `initial` snapshot prepend quirk (see follow-up memory).
4. **Hand-rolled toast** (no sonner/react-hot-toast): `ToastProvider` + `useToast()` in `src/hooks/use-toast.tsx`, viewport mounted in `App.tsx`; plus shared `ErrorBanner` component replacing the copy-pasted destructive banner. Banners for load errors (persistent), toasts for action errors (transient).
5. **Scope:** wire ONLY the sessions page this pass; remaining silent-failure sites → follow-up memory note.

## Status: COMPLETED (2026-09-09, branch `feat/general-coordinator-ui-polish`)

All six steps executed and validated. Acceptance mapping verified (all passing):

- **Symptom 1 (phantom at top → wrong position)** → `pending rows keep their list position` (3-row payload, archive middle row, sibling order asserted).
- **Symptom 2 (next archive replaces phantom)** → `a second archive leaves earlier undo rows intact` (two pendings, both Undo buttons).
- **Symptom 3 (no replacement row on expiry)** → `pending row disappears and the next row loads after the undo window` (expiry refetch returns the next row; slot backfills).
- **Error display** → `failed archive shows an error toast and keeps the row`, `failed undo shows an error toast and refetches`, `use-toast.test.tsx` (6 cases incl. auto-dismiss/stack/cap/manual-dismiss/outside-provider-throw), `error-banner.test.tsx` (3 cases).

## Implementation summary

- **NEW `drone-coordinator-ui/src/hooks/use-toast.tsx`** — `ToastProvider` + `useToast()` (throws outside provider), `error(message)` API, 5s auto-dismiss, max-4 stack (oldest dropped), fixed bottom-right viewport (`aria-live=assertive`, `role=alert` toasts, manual dismiss), destructive palette. `TOAST_DURATION_MS`/`MAX_TOASTS` exported.
- **NEW `src/components/error-banner.tsx`** — shared banner with `message: string | null | undefined` (widened from the plan's `string` so it can take state-typed `string | null` directly; renders null when falsy), preserves the exact legacy banner classes.
- **MOD `src/App.tsx`** — `<ToastProvider>` as outermost provider.
- **MOD `src/pages/sessions.tsx`** — in-place pending rows: `archivedPendingIds` state + `pendingRef` (Map id→{row,timer}) + `offsetRef` + unmount timer cleanup; single `clearPending(id)` helper used by both `expirePending` (timer → clear → refetch at `offsetRef.current`) and `handleUndoArchive` (lookup → clear → POST restore → toast on failure → refetch either way); `fetchSessions` merges pending rows omitted by `exclude=archived` back into the page (newest-first, capped to PAGE_SIZE, matching server `createdAt DESC`); all six action handlers now check `res.ok` → `showError(...)` + early return (no fake refresh); banner JSX → `<ErrorBanner>`; empty-state check simplified to `sessions.length === 0`; phantom-row block deleted.
- **MOD `src/pages/sessions.test.tsx`** — ToastProvider in wrapper; new `scriptedFetch(listResponses, actionFailures)` (call-indexed list GETs + per-route POST failures); 11 cases covering acceptance mapping above.

## Validation results (2026-09-09)
1. **LSP:** clean on all touched files + workspace-wide UI diagnostics (pre-existing `drone-coordinator/test/beacon-ws.test.ts:167` is out of scope).
2. **`pnpm lint`** clean (root-only script; `pnpm -r run lint` has no per-package lint scripts — ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT).
3. **`pnpm -r run build`** and **`pnpm typecheck`** (root, incl. tsconfig.test.json) clean.
4. **Fast suite: root `pnpm test` = 200 files / 2824 passed / 14 skipped, green.** Note: `pnpm -r run test` fails in `drone-core` with "No test files found" — drone-core has a bare `vitest run` script but no package-local vitest config, so its include globs resolve to nothing; the root vitest config covers `drone-core/test/**`. PRE-EXISTING, unrelated to this plan; the root suite is the operative fast suite. Targeted `pnpm --filter drone-coordinator-ui test` (NODE_ENV=test) = 23 files / 166 passed.
5. Acceptance mapping verified above via verbose reporter.

## En-route notes (for future plans)
- `pnpm -r run lint` is not a valid command on this monorepo (root-only scripts); the AGENTS.md command table's `pnpm -r run lint` form does not match current packaging — use root `pnpm lint`.
- `pnpm -r run test` trips on drone-core's scriptless-config `vitest run` (pre-existing); use root `pnpm test` for the fast suite.
- LSP diagnostics in this environment can lag file edits by one call; re-query after a no-op read to refresh.

## Accepted transients (not bugs)
- Between archive and expiry, the "Showing X–Y of N" count is stale until the expiry/undo refetch.
- A pending row followed across pagination pages via the refetch-merge is accepted (single uniform code path; row is in limbo until undo/expiry).
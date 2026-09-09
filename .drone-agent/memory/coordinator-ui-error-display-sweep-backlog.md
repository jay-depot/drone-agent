---
key: coordinator-ui-error-display-sweep-backlog
tags:
  - coordinator-ui
  - error-display
  - completed
created: 2026-09-09T15:17:38.941Z
updated: 2026-09-09T16:43:23.771Z
---

# Coordinator UI — error-display sweep backlog (COMPLETE 2026-09-09)

Deferred from plan `plan-coordinator-ui-archive-undo-and-error-display`. **The sweep is done.** This memory is retained as a completion record; delete it whenever the separate WS design item below is resolved.

## Completed
Commits `1c93b6c`, `f8b28b1`, `cc6df6c` on `feat/general-coordinator-ui-polish` (sessions-page scope landed earlier via `752351c`):

1. **`useApi` promoted** as the shared fetch layer (`src/hooks/use-api.ts`). Two latent bugs fixed en route: the `urlRef` guard suppressed the mount fetch entirely (hook never auto-fetched; only manual `refetch()` worked — zero tests + zero consumers had hidden it), and a missing statusText fallback produced `HTTP 500: undefined` (now `Unknown error`). Shared normalizers exported: `extractApiError(res)` + `networkErrorMessage(err)`.
2. **Six delete handlers** (wiki/skills/personas/skill-detail/persona-detail/wiki-detail): `!res.ok` → toast + early return; catch → toast. Error-path tests for all six (4 new test files + wiki-detail additions).
3. **topology.tsx trust dialog** (approve/reject/remove): branches collapsed to one; toast on failure and **dialog stays open** (user decision: retry/cancel in place); close + refetch on success. 4 new tests.
4. **session-detail.tsx events load**: failed load shows an `ErrorBanner` (cleared on next fetch) instead of the fake "No events yet"; empty state deliberately kept below the banner so live WS events recover the page. First-ever tests for the page — note jsdom lacks `scrollIntoView`; stubbed per-file (`Element.prototype.scrollIntoView = vi.fn()`); move to a shared setup file if more scrolling pages get tests.
5. **wiki.tsx search**: failure toasts instead of silently falling back to the unfiltered list; search **debounced 350ms** (`SEARCH_DEBOUNCE_MS`) with a stale-response guard — the visible failures exposed per-keystroke request spam (user approved the debounce).
6. **Banner swap**: NINE inline destructive banners → `<ErrorBanner>` (backlog listed 7; grep found 2 more in `personas.tsx`/`skills.tsx`). Zero copy-pasted banners remain in `pages/`. Detail pages' full-page "not found" center text intentionally stays (different pattern; "not found" is not an error).
7. **sessions.tsx beacon-name enrichment** (~L96): degrade to raw beacon IDs when `GET /api/beacons` fails — accepted as intentional; no change.
8. **login.tsx**: inline red field-level error under the input is the right form-field pattern; permissive 429/5xx/network fallbacks are deliberate; confirmed no change.

## Separate (still open, needs its own design session)
- `sessions.tsx` WS `initial` handler blindly PREPENDS snapshot sessions not already in the list; the coordinator's initial snapshot is active-sessions-only, so active sessions land at the TOP of the list on WS (re)connect — including in the archived view, and above merged pending rows. Needs a design decision: proper merge semantics, or drop the `initial` subscription in favor of `session.*` event subscriptions (pattern used by topology/session-detail/beacon-detail).
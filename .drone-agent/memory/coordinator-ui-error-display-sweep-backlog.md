---
key: coordinator-ui-error-display-sweep-backlog
tags:
  - coordinator-ui
  - error-display
  - completed
created: 2026-09-09T15:17:38.941Z
updated: 2026-09-09T16:57:42.183Z
---

# Coordinator UI — error-display sweep backlog (COMPLETE 2026-09-09, incl. WS item)

Deferred from plan `plan-coordinator-ui-archive-undo-and-error-display`. **The sweep and the separate WS design item are both done.** This memory is a completion record; safe to delete.

## Completed
Commits `1c93b6c`, `f8b28b1`, `cc6df6c`, `288fb70` on `feat/general-coordinator-ui-polish` (sessions-page scope landed earlier via `752351c`):

1. **`useApi` promoted** as the shared fetch layer (`src/hooks/use-api.ts`). Two latent bugs fixed en route: the `urlRef` guard suppressed the mount fetch entirely (hook never auto-fetched; only manual `refetch()` worked — zero tests + zero consumers had hidden it), and a missing statusText fallback produced `HTTP 500: undefined` (now `Unknown error`). Shared normalizers exported: `extractApiError(res)` + `networkErrorMessage(err)`.
2. **Six delete handlers** (wiki/skills/personas/skill-detail/persona-detail/wiki-detail): `!res.ok` → toast + early return; catch → toast. Error-path tests for all six.
3. **topology.tsx trust dialog** (approve/reject/remove): branches collapsed to one; toast on failure and **dialog stays open** (user decision: retry/cancel in place); close + refetch on success.
4. **session-detail.tsx events load**: failed load shows an `ErrorBanner` (cleared on next fetch) instead of the fake "No events yet"; empty state deliberately kept below the banner. First-ever tests — jsdom lacks `scrollIntoView`; stubbed per-file; move to a shared setup file if more scrolling pages get tests.
5. **wiki.tsx search**: failure toasts instead of silently falling back to the unfiltered list; search **debounced 350ms** (`SEARCH_DEBOUNCE_MS`) with a stale-response guard.
6. **Banner swap**: NINE inline destructive banners → `<ErrorBanner>` (backlog listed 7; grep found 2 more in `personas.tsx`/`skills.tsx`). Zero copy-pasted banners remain in `pages/`. Detail pages' full-page "not found" center text intentionally stays.
7. **sessions.tsx beacon-name enrichment**: degrade to raw beacon IDs when `GET /api/beacons` fails — accepted as intentional; no change.
8. **login.tsx**: inline red field-level error is the right form-field pattern; permissive 429/5xx/network fallbacks are deliberate; no change.
9. **WS `initial` blind-prepend (design item, Semantics B)**: sessions.tsx no longer consumes the `initial` snapshot (active-sessions-only; the old handler injected active sessions at the TOP on every reconnect, incl. archived view + above pending rows). Now subscribed to the session-lifecycle allowlist (`session.created|ended|processing|processed|archived`); each event triggers a 100ms-debounced `fetchSessions(offsetRef.current)` — reusing the pending-undo merge, view filter respected by construction. Generic relay events (`message`, `roundComplete`, …) ignored to avoid per-agent-turn refetches. Server unchanged (`initial` still serves topology/session-detail). Bug pinned by test: an arriving `initial` snapshot now causes no state change. Test-env note: per-describe `vi.stubGlobal('WebSocket', MockWebSocket)` is needed in blocks whose earlier siblings call `vi.unstubAllGlobals()` in afterEach.
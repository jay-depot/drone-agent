---
key: plan-session-detail-live-chat-resilience
tags:
  - plan
  - coordinator-ui
  - session-detail
  - bugfix
  - websocket
  - status: completed
created: 2026-09-08T23:52:43.341Z
updated: 2026-09-09T00:01:57.332Z
---

# Plan: Session-detail live-chat resilience (WS crash fix + late-registration recovery)

status: completed (2026-09-09, session on branch feat/coordinator-ui-sessions)

## Feature

Fix the two defects that hide the interactive remote-control UI on the coordinator session-detail page (feature: ADR 198, commit 785d10ef, branch `feat/coordinator-ui-sessions`). After this, spawning a session and landing on its page yields a working chat input with no manual refresh, and live WS events never blank the page.

## Root causes (verified in code)

1. **Crash (blocker):** `crypto.randomUUID()` in the WS event-append handler (`drone-coordinator-ui/src/pages/session-detail.tsx` ~line 108) — undefined on non-secure origins (e.g. `http://ambiorix:4300`). First WS event throws during setState → React unmounts → blank page. Regression introduced in 785d10ef (older session-detail only rendered REST events with real server ids).
2. **No recovery:** metadata fetch (`GET /api/sessions/:id`) runs once on mount and swallows failures. Right after spawn the agent has not yet registered (`session.created` not yet fired) → 404 → `session` stays null → `liveInteractive` never true → chat input never renders until a manual refresh.

## Decisions locked

- Local monotonic counter ids (`ws-N`) for WS-appended events — id is only a React key; matches the TUI `useChatLog.ts` pattern. Server-provided ids are a separate follow-up (memory `followup-coordinator-ws-event-ids`).
- Recovery = WS-event-triggered refetch on session-lifecycle eventTypes for this session (`session.created`, `session.ended`, `session.processing`, `session.processed`, `session.archived`, `session.restored` — all published via `publishMutationEvent` today) + bounded timer retry (3 attempts, 2s apart) only while `session === null`. No polling loop.
- Refetch on lifecycle events also removes the input box live when a session ends/archives while viewed.

## Steps

1. (coder) `session-detail.tsx` — replace `crypto.randomUUID()` with a `useRef(0)` counter: `id: \`ws-\${(localEventIdRef.current += 1)}\``. ✅
2. (coder) `session-detail.tsx` — extract the metadata fetch into a `fetchSession` callback; add bounded retry (max 3, 2s delay, only while `session === null`, cancelled-flag safe, reset on `sessionId` change, timers cleared on unmount); inside the existing WS `subscribe('event', ...)` handler, call `fetchSession()` when `eventMsg.eventType` is a session-lifecycle type and `eventMsg.sessionId === sessionId`. ✅
3. (tester) `drone-coordinator-ui/src/pages/session-detail.test.tsx` (new) — cases (a) WS append without crypto.randomUUID (non-secure crypto stub), (b) input only when `active && interactive` (both negative variants tested: non-interactive + ended), (c) initial 404 → `session.created` WS event → refetch → input appears, (d) initial 404 → timer retry succeeds → input appears + retry stops after success. All `waitFor`-based. ✅
4. (coder) lint + build. ✅ (see validation note)
5. (reviewer) diff review — plan-scoped, no scope creep; `grep randomUUID` across drone-coordinator-ui/src: only test-file references remain. ✅
6. Final validation. ✅ (see below)

## Validation results

- LSP: zero errors/warnings (only pre-existing hints in untouched files).
- `pnpm lint` (root script = eslint + prettier) passes. NOTE: `pnpm -r run lint` does not exist — per-package lint scripts were never added; the root script is the gate.
- `pnpm -r run build` passes (all packages, incl. `tsc --noEmit` for the UI).
- Fast suite: root `pnpm test` = 2858 passed / 0 failed (204 files). NOTE: `pnpm -r run test` fails spuriously in drone-core (its vitest config uses root-relative include paths); the root script is the real fast suite. The UI package's own script is hermetic (`NODE_ENV=test vitest run`) and passes 6/6 new tests.
- Manual spawn-flow check not run (no live swarm from this session); logic covered by tests (c)/(d).

## Test-authoring lessons (for future UI tests here)

- jsdom lacks `scrollIntoView` — stub `window.HTMLElement.prototype.scrollIntoView` or the auto-scroll effect throws and unmounts the tree.
- `vi.stubGlobal('WebSocket', ...)` at module top level is lost after the first `vi.unstubAllGlobals()` in afterEach — re-stub in beforeEach.
- Badges render `● Live — Interactive` (leading bullet) — match with regex; scope event-type lookups with `{ selector: '[data-slot="badge"]' }` (the Collapsible header div makes bare getByText ambiguous).
- The mount-time REST `setEvents([])` can land AFTER a synchronously-dispatched WS append and clobber it — synchronize on the initial fetch settling (`findByText('No events yet')`) before dispatching WS events. This race also exists in production (tiny window); see `followup-coordinator-ws-event-ids`.

## Out of scope (unchanged)

- Server-provided event ids in publishEvent + REST/WS event dedup (see `followup-coordinator-ws-event-ids`).
- Chat UX (transcript rendering, message bubbles) — separate iteration.
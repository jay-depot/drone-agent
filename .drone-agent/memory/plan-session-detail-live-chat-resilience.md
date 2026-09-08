---
key: plan-session-detail-live-chat-resilience
tags:
  - plan
  - coordinator-ui
  - session-detail
  - bugfix
  - websocket
created: 2026-09-08T23:52:43.341Z
updated: 2026-09-08T23:52:43.341Z
---

# Plan: Session-detail live-chat resilience (WS crash fix + late-registration recovery)

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
1. (coder) `session-detail.tsx` — replace `crypto.randomUUID()` with a `useRef(0)` counter: `id: \`ws-\${(localEventIdRef.current += 1)}\``.
2. (coder) `session-detail.tsx` — extract the metadata fetch into a `fetchSession` callback; add bounded retry (max 3, 2s delay, only while `session === null`, cancelled-flag safe, reset on `sessionId` change, timers cleared on unmount); inside the existing WS `subscribe('event', ...)` handler, call `fetchSession()` when `eventMsg.eventType` is a session-lifecycle type and `eventMsg.sessionId === sessionId`.
3. (tester) `drone-coordinator-ui/src/pages/session-detail.test.tsx` (new) — (a) WS append works with `crypto.randomUUID` removed from the env (pins the regression); (b) input renders only when `active && interactive`; (c) initial 404 → `session.created` WS event → refetch → input appears; (d) initial 404 → timer retry succeeds without WS traffic → input appears. Use `waitFor`, never fixed sleeps (project principle).
4. (coder) `pnpm -r run lint && pnpm -r run build` (prettier may reformat — re-read files before further edits).
5. (reviewer) review diff for scope creep; `grep randomUUID` across drone-coordinator-ui/src to confirm no other synthesis sites.
6. Final validation per criteria below.

## Validation criteria
- LSP diagnostics clean (all packages).
- `pnpm -r run lint`, `pnpm -r run build`, `pnpm -r run test` (fast) all pass.
- New tests cover cases (a)–(d) and pass under the UI package's hermetic test runner (`NODE_ENV=test`).
- Manual (if swarm up): spawn from the sessions page → detail page auto-gains the chat input when the agent registers; incoming events never blank the page on a plain-HTTP remote origin.

## Out of scope
- Server-provided event ids in publishEvent (see `followup-coordinator-ws-event-ids`).
- Chat UX (transcript rendering, message bubbles) — separate iteration.
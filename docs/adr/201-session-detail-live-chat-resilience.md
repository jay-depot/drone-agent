---
tags: [coordinator-ui, websocket, session-detail, adr]
related:
  [
    drone-coordinator-ui.md,
    decisions/198-coordinator-ui-launch-interact.md,
    followup-coordinator-ws-event-ids.md,
  ]
---

# Session-detail live-chat resilience: WS event crash fix + late-registration recovery

**Summary**: Fixes two defects that hid the interactive remote-control UI (ADR 198) on the coordinator session-detail page: (1) the WS event-append handler called `crypto.randomUUID()` — undefined on non-secure origins (any plain-HTTP remote host, e.g. `http://ambiorix:4300`), so the first incoming event threw during a state update and React unmounted the page; the id is only a React key, so it is now a local `ws-N` monotonic counter. (2) The page fetched session metadata exactly once on mount and swallowed failures — right after a spawn that fetch 404s (the agent registers seconds later), so the chat input never appeared without a manual refresh; the fetch is now a `fetchSession` callback with a bounded retry (3 attempts, 2 s apart, only while the session is unknown) plus a refetch on session-lifecycle events over the already-open WebSocket, so the input and "● Live — Interactive" badge appear when the agent registers and disappear live when the session ends.

## Context

ADR 198 delivered the launch panel + interactive chat. First real-world use on a plain-HTTP remote origin (`http://ambiorix:4300`) hit two failures in sequence: the page crashed to blank on the first WS event, and after a manual refresh the chat input only appeared because the manual refresh re-ran the metadata fetch after the agent had registered.

**Crash root cause**: `crypto.randomUUID()` is defined only in secure contexts (HTTPS or `localhost`). The event id is consumed solely as a React reconciliation key for transiently-appended events, but the API was used as if UUID semantics were needed. Introduced in `785d10ef` (the ADR 198 commit): the older session-detail rendered only REST-fetched events, which carry real server ids.

**Recovery root cause**: `GET /api/sessions/:id` runs once on mount in a best-effort effect that swallows errors. The spawn flow navigates to the new session's detail page immediately (the beacon responds 202 while the agent is still booting — CLI parse → engine init → swarm plugin connect → registration takes seconds), so the fetch 404s, `session` stays `null`, `liveInteractive` (status active + interactive) never turns true, and the input box never renders. No polling, no retry, no refetch trigger existed.

## Decision

1. **Counter ids, not UUIDs, for WS-appended events.** The id is only a React key within the page's lifetime. `ws-<n>` from a `useRef` counter matches the TUI's existing `useChatLog.ts` pattern. Server-provided event ids in `publishEvent` are deliberately deferred (the follow-up also unlocks REST/WS event dedup — the mount-time REST events fetch can clobber a WS append that lands while it is in flight).
2. **Recovery = WS-lifecycle refetch + bounded timer retry, no polling loop.** Refetch fires when a session-lifecycle eventType for the viewed session arrives (`session.created`, `session.ended`, `session.processing`, `session.processed`, `session.archived`, `session.restored` — all published via `publishMutationEvent` today). The timer retry (max 3 attempts, 2 s apart, guarded by a `hasSessionRef` so any success — retry, WS-triggered, or otherwise — stops it) covers agent boot without a WS event. Refetching on lifecycle events also removes the input live when a session ends/archives while viewed.
3. **No backend changes.** The coordinator already publishes every needed signal; this is a UI-only fix.

## Implementation

- `drone-coordinator-ui/src/pages/session-detail.tsx` — `localEventIdRef` counter replaces `crypto.randomUUID()`; `fetchSession` useCallback (returns success, updates `hasSessionRef`) + bounded-retry effect (cancel-safe, timer cleared on unmount, reset on `sessionId` change); the existing WS `subscribe('event')` handler calls `fetchSession()` on matching lifecycle eventTypes before the append.

## Tests

- `drone-coordinator-ui/src/pages/session-detail.test.tsx` (new, 6, all `waitFor`-based): regression pin for the non-secure-origin crash (crypto stubbed without `randomUUID`); input renders only for `active && interactive` (non-interactive and ended variants); initial 404 → `session.created` WS event → refetch → input appears; initial 404 → timer retry succeeds with no WS traffic, and the retry stops after success.

## Key Points

- **Secure-context-only Web APIs break remote HTTP UIs** — `crypto.randomUUID()` (and friends) vanish on plain-HTTP remote hosts; reserve them for genuinely UUID-needing cases or provide fallbacks. An id needed only as a React key needs neither.
- **A one-shot fetch on mount cannot serve a not-yet-ready resource** — when the thing you fetch appears asynchronously (agent registration), design for the miss: event-triggered refetch plus a bounded retry, not a manual-refresh requirement.
- **Test authoring under jsdom** (all encountered here, logged as insights): `scrollIntoView` is unimplemented (the auto-scroll effect throws and unmounts the tree — stub it); module-top-level `vi.stubGlobal` is lost after the first `unstubAllGlobals` (re-stub in `beforeEach`); Base-UI Collapsible headers make bare `getByText` ambiguous (scope with `selector: '[data-slot="badge"]'`); a synchronously-dispatched WS event races the mount-time REST fetch's `setEvents` — synchronize on the fetch settling first.

## Related

- [198-coordinator-ui-launch-interact](198-coordinator-ui-launch-interact.md) — the launch/interact feature whose UI this makes usable from plain-HTTP remote origins
- [drone-coordinator-ui](../../drone-coordinator-ui/) — the page (`session-detail.tsx`) and its test file
- `followup-coordinator-ws-event-ids` (project memory) — deferred cross-cutting follow-up: server-provided event ids in `publishEvent`, enabling key reuse + REST/WS event dedup

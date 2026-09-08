---
key: followup-coordinator-ws-event-ids
tags:
  - follow-up
  - coordinator
  - websocket
  - coordinator-ui
  - cross-cutting
created: 2026-09-08T23:52:43.340Z
updated: 2026-09-08T23:52:43.340Z
---

Follow-up (cross-cutting, deferred from session-detail crash fix): the coordinator's WS push (`publishEvent`/`publishMutationEvent` in drone-coordinator/src/ws-pubsub.ts) sends `{ type, sessionId, eventType, payload }` with NO event id. This forces UI consumers to synthesize local ids for WS-appended events — the cause of the `crypto.randomUUID()` crash fixed in plan-session-detail-live-chat-resilience (session-detail.tsx was the only randomUUID site; replaced with a local `ws-N` counter).

Proposed follow-up: include the persisted event id (or a server-assigned id) in publishEvent/publishMutationEvent payloads, extend the UI `WsEventMessage` type, and have session-detail reuse it as the React key. Bonus: with real ids the UI can dedupe the REST event fetch against the WS stream (currently a race between mount-time `GET /api/sessions/:id/events` and concurrent WS pushes can render the same event twice).

Affected consumers of WsEventMessage: session-detail.tsx, topology.tsx, beacon-detail.tsx. Touches ws-pubsub.ts + every route that calls publishMutationEvent (17 call sites) — sweep with LSP find-references on publishMutationEvent before changing the payload shape.
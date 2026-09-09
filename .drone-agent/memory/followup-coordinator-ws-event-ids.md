---
key: followup-coordinator-ws-event-ids
tags:
  - follow-up
  - coordinator
  - websocket
  - coordinator-ui
  - cross-cutting
created: 2026-09-08T23:52:43.340Z
updated: 2026-09-09T00:02:10.735Z
---

Follow-up (cross-cutting, deferred from plan-session-detail-live-chat-resilience): the coordinator's WS push (`publishEvent`/`publishMutationEvent` in drone-coordinator/src/ws-pubsub.ts) sends `{ type, sessionId, eventType, payload }` with NO event id. This forces UI consumers to synthesize local ids for WS-appended events — the cause of the `crypto.randomUUID()` crash fixed in plan-session-detail-live-chat-resilience (session-detail.tsx was the only randomUUID site; replaced with a local `ws-N` counter).

Proposed follow-up: include the persisted event id (or a server-assigned id) in publishEvent/publishMutationEvent payloads, extend the UI `WsEventMessage` type, and have session-detail reuse it as the React key. With real ids the UI can also fix the REST/WS dedup race (updated 2026-09-09 after executing the plan): session-detail's mount-time `GET /api/sessions/:id/events` resolves its `setEvents(data)` whenever the fetch lands; a WS event appended in the interim (fetch in flight, events still []) is CLOBBERED by the fetch's `[]`/stale array — losing the live event. Tiny production window, but the same merge hazard covers any concurrent REST+WS event appends. Real ids would let the merge dedupe by id instead of overwrite-by-source. Alternative cheaper fix: in the WS handler use `setEvents(prev => ...)` with a fetch-generation guard (ignore REST results older than the first WS append).

Affected consumers of WsEventMessage: session-detail.tsx, topology.tsx, beacon-detail.tsx. Touches ws-pubsub.ts + every route that calls publishMutationEvent (17 call sites) — sweep with LSP find-references on publishMutationEvent before changing the payload shape.
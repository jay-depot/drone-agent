---
tags: [decision, drone-coordinator, drone-coordinator-ui, drone-beacon, topology, websocket, live-events]
related: [modules/drone-coordinator.md, modules/drone-coordinator-ui.md, modules/drone-beacon.md, concepts/mtls-and-reverse-channel.md, decisions/089-coordinator-live-events-api-paths.md]
---

# 191: Swarm topology status = live WebSocket state

**Status**: Implemented (2026-09-04, branch `feat/memory-wiki-browser-improvements`, from completed plan `plan-swarm-topology-live-ws-status`)

## Context

The swarm topology page (and beacon detail page) derived a beacon's
"online/offline" status from a **5-minute heartbeat heuristic**
(`Date.now() - lastHeartbeat < 5*60*1000`). That signal is wrong in both
directions: a long-idle but still-connected beacon showed red (offline), while
a recently-restarted beacon that had merely re-registered showed green
(online) — the "detects recently restarted" bug. Meanwhile the coordinator
already tracked the ground truth: each beacon holds a persistent,
auto-reconnecting reverse-channel WebSocket to `/ws/beacon`, and
`isBeaconConnected(beaconId)` in `beacon-ws.ts` reports whether that
connection is live right now.

## Decision

Use the live WebSocket state as the status signal and wire it end to end.

1. **beacon-ws.ts lifecycle refactor** (`drone-coordinator/src/beacon-ws.ts`):
   `registerBeaconConnection(beaconId, ws)` / `unregisterBeaconConnection(beaconId)`
   become the single choke points for connection lifecycle; both publish
   `beacon.connected` / `beacon.disconnected` via `ws-pubsub.publishMutationEvent`
   (payload `{ beaconId }`) and fire test hooks. The `pong` handler
   (`ws.on('pong', () => conn.isAlive = true)`) lives inside
   `registerBeaconConnection` so real and test connections behave identically.
2. **Half-open socket hardening**: `startBeaconLivenessSweep(intervalMs = 30000)`
   runs a `setInterval` over all connections — if `!isAlive`, terminate the
   socket and explicitly unregister (publishing `beacon.disconnected`); else
   set `isAlive = false` and `ws.ping()`. Returns the interval (unref'd) for
   shutdown. Wired in `index.ts` inside the mTLS branch after
   `registerBeaconWebSocket`.
3. **API**: `GET /beacons` and `GET /beacons/:id` gain
   `connected: isBeaconConnected(id)`. The UI `/ws` socket's initial-state
   message maps beacons with the same `connected` field.
4. **UI** (`drone-coordinator-ui`): `Beacon.connected?: boolean`;
   `topology.tsx` replaces `isBeaconOnline` (heartbeat) with `getBeaconStatus`
   — green when `connected`, amber when trust-pending, red otherwise. Live
   updates: both `topology.tsx` and `beacon-detail.tsx` subscribe to
   `beacon.connected` / `beacon.disconnected` on the shared `/ws` socket and
   flip the status dot in place. "Last Heartbeat" stays as an informational
   row; card `opacity-70` only when offline.

## Consequences

- Status is now a *connection* property, not a liveness guess: an idle beacon
  that stays connected stays green; a crashed beacon turns red the moment the
  sweep (or a real close) notices.
- Half-open sockets (peer gone without FIN) are reaped within one sweep
  interval instead of lingering forever.
- Event-driven UI updates replace polling.

## Tests

- `drone-coordinator/test/beacon-ws.test.ts`: lifecycle publish tests
  (`_setLifecycleHooks`), liveness-sweep tests (dead connection terminated +
  `beacon.disconnected` published; alive connection that pongs survives across
  sweeps) — fake timers + fake ws with a handlers map.
- `drone-coordinator/test/routes/beacons.test.ts`: `connected` false when
  unconnected, true after `_registerTestConnection`.
- `drone-coordinator-ui`: new `topology.test.tsx` and `beacon-detail.test.tsx`
  (green/red/amber from `connected` + `trustStatus`, live events flip the dot).

## Related

- mtls-and-reverse-channel — the reverse channel this monitors
- [089-coordinator-live-events-api-paths](089-coordinator-live-events-api-paths.md) — the `/ws` event channel
- [093-session-status-mismatch-fix](093-session-status-mismatch-fix.md) — precedent for replacing a
  heuristic with explicit state

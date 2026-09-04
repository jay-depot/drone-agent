---
key: plan-swarm-topology-live-ws-status
tags: []
created: 2026-09-04T19:59:50.905Z
updated: 2026-09-04T20:11:32.739Z
---

# Plan: E1 — Swarm Topology status indicators = live WebSocket state (APPROVED 2026-09-04)

## STATUS: COMPLETED 2026-09-04. All steps implemented, tested, and committed on feat/memory-wiki-browser-improvements.

## Summary

The swarm topology page (and beacon detail page) show a beacon's "online/offline" status using a 5-minute heartbeat heuristic (`Date.now() - lastHeartbeat < 5*60*1000`). This is wrong: a long-idle but still-connected beacon shows red (offline), while a recently-restarted beacon that re-registered shows green (online) — the "detects recently restarted" bug.

The coordinator ALREADY tracks live reverse-channel WebSocket connections per beacon (`isBeaconConnected(beaconId)` in `beacon-ws.ts`), fed by the beacon's persistent, auto-reconnecting WS to `/ws/beacon`. That is a true, live "is the beacon online right now" signal. The fix wires that signal through the API and UI, adds live updates over the UI's /ws socket, and hardens half-open socket detection.

## User decisions (locked in)

- Q1: Only topology.tsx + beacon-detail.tsx need the status.
- Q2: Untrusted (pending) = AMBER; other "never seen" cases impossible in this architecture — ignore.
- Q3: YES — live updates via published `beacon.connected` / `beacon.disconnected` events on the UI /ws.
- Q4: YES — `connected` on both GET /beacons and GET /beacons/:id.
- Q5: Field name `connected` (not `online`).
- Q6: YES — harden half-open down detection now (ping/pong isAlive sweep).

## Implementation (what was actually done)

### Backend (drone-coordinator)

1. src/beacon-ws.ts:
   - Added `isAlive: boolean` to `BeaconConnection`.
   - Refactored lifecycle into `registerBeaconConnection(beaconId, ws)` / `unregisterBeaconConnection(beaconId)`; both publish `beacon.connected` / `beacon.disconnected` via ws-pubsub `publishMutationEvent` (payload { beaconId }) and fire test hooks.
   - pong handler (`ws.on('pong', () => conn.isAlive = true)`) lives in registerBeaconConnection (so real + test connections behave identically).
   - Added `startBeaconLivenessSweep(intervalMs = 30000)`: setInterval over connections; if `!isAlive` → `ws.terminate()` + explicit `unregisterBeaconConnection`; else `isAlive=false; ws.ping()`. Returns interval (unref'd) for shutdown.
   - Test hooks added: `_setLifecycleHooks`, `_getConnection`; `_registerTestConnection` now routes through registerBeaconConnection; `resetBeaconConnections` uses unregisterBeaconConnection and clears hooks.
2. src/routes/beacons.ts: `connected: isBeaconConnected(id)` on GET /beacons and GET /beacons/:id.
3. src/index.ts: `/ws` (UI) initial message beacons mapped `{ ...b, connected: isBeaconConnected(b.id) }`; `startBeaconLivenessSweep()` wired in buildApp's enableMtls branch after registerBeaconWebSocket.

### Frontend (drone-coordinator-ui)

4. src/lib/types.ts: `Beacon.connected?: boolean`.
5. src/pages/topology.tsx: replaced `isBeaconOnline` heartbeat with `getBeaconStatus` (green connected / amber pending / red otherwise); subscribes to `beacon.connected`/`beacon.disconnected` events to live-update; keeps "Last Heartbeat" row informational; card opacity-70 only when offline.
6. src/pages/beacon-detail.tsx: same — `connected` + 3-color status + live event subscription updates the header dot.

## Tests

### Coordinator

- test/beacon-ws.test.ts: lifecycle publish tests (onConnected/onDisconnected via _setLifecycleHooks), liveness sweep tests (dead conn terminated + disconnected published; alive conn that pongs survives across sweeps). Uses fake timers + a fake ws with a handlers map.
- test/routes/beacons.test.ts: GET /beacons and /:id report connected=false when unconnected and connected=true after _registerTestConnection.

### UI

- topology.test.tsx (new): green/red/amber dots from connected+trustStatus (not heartbeat); live `beacon.connected`/`beacon.disconnected` events flip the dot.
- beacon-detail.test.tsx (new): same.

## Validation (all passed)

- `pnpm -r run build` PASS
- eslint project-wide PASS; prettier clean
- Coordinator tests 344 PASS
- UI tests 69 PASS
- Full monorepo test 2738 PASS

## Key facts learned during execution

- `file__apply_diff` "fuzz" can misapply hunks to the wrong import block (added `isBeaconConnected` into the `drone-swarm-common` import instead of `./beacon-ws.js`) — verify import blocks after apply_diff.
- Multi-hunk apply_diff on a React useEffect region mangled topology.tsx (merged the initial + event effects) — tests caught it; repaired manually. Always re-run the affected test file after apply_diff.
- LSP diagnostics can be stale/cached; trust authoritative `tsc -b` / `tsc --noEmit`.
- @fastify/websocket WebSocket aliases `ws` pkg: .ping()/.pong()/.isAlive/.terminate(); ws auto-pongs.

---
key: plan-swarm-topology-live-ws-status
tags:
  []
created: 2026-09-04T19:59:50.905Z
updated: 2026-09-04T19:59:50.905Z
---

# Plan: E1 — Swarm Topology status indicators = live WebSocket state (APPROVED 2026-09-04)

## Summary
The swarm topology page (and beacon detail page) show a beacon's "online/offline" status using a 5-minute heartbeat heuristic (`Date.now() - lastHeartbeat < 5*60*1000`). This is wrong: a long-idle but still-connected beacon shows red (offline), while a recently-restarted beacon that re-registered shows green (online) — the "detects recently restarted" bug.

The coordinator ALREADY tracks live reverse-channel WebSocket connections per beacon (`isBeaconConnected(beaconId)` in `beacon-ws.ts`), fed by the beacon's persistent, auto-reconnecting WS to `/ws/beacon` (drone-beacon/src/coordinator-ws.ts, exponential backoff 1s→30s). That is a true, live "is the beacon online right now" signal. The fix wires that signal through the API and UI, adds live updates over the UI's /ws socket, and hardens half-open socket detection.

## User decisions (locked in)
- Q1: Only topology.tsx + beacon-detail.tsx need the status.
- Q2: Untrusted (pending) = AMBER; other "never seen" cases impossible in this architecture — ignore.
- Q3: YES — live updates via published `beacon.connected` / `beacon.disconnected` events on the UI /ws.
- Q4: YES — `connected` on both GET /beacons and GET /beacons/:id.
- Q5: Field name `connected` (not `online`).
- Q6: YES — harden half-open down detection now (ping/pong isAlive sweep).

## Backend (drone-coordinator)
### Step 1 — src/beacon-ws.ts: half-open liveness sweep + connect/disconnect events
- Add `isAlive: boolean` to `BeaconConnection` (default true on register).
- In `/ws/beacon` handler: set `conn.ws.isAlive = true`, add `socket.on('pong', () => (conn.isAlive = true))`.
- Add `export function startBeaconLivenessSweep(app: FastifyInstance): void` — setInterval (e.g. 30s) over `connections`; if `!conn.isAlive`, `conn.ws.terminate()` (fires close → removal + disconnected event); else set `isAlive = false` and `conn.ws.ping()`.
- Publish via ws-pubsub `publishMutationEvent`: `beacon.connected` on connect, `beacon.disconnected` on close (payload `{ beaconId }`).
- Import `publishMutationEvent` from `./ws-pubsub.js` — clean (no cycle: beacon-ws → ws-pubsub → logger; session-end already imports both).

### Step 2 — src/routes/beacons.ts: expose `connected`
- GET /beacons: add `connected: isBeaconConnected(b.id)` to each mapped beacon.
- GET /beacons/:id: add `connected: isBeaconConnected(request.params.id)`.
- Import `isBeaconConnected` from `../beacon-ws.js`.

### Step 3 — src/index.ts: /ws initial message
- In attachUi /ws handler, map listBeacons → `{ ...b, connected: isBeaconConnected(b.id) }` before publishInitialState.

## Frontend (drone-coordinator-ui)
### Step 4 — src/lib/types.ts: add `connected?: boolean;` to local Beacon interface.

### Step 5 — src/pages/topology.tsx
- Replace isBeaconOnline heartbeat with `beacon.connected ?? false`.
- 3-color dot: GREEN (connected===true) / RED (connected===false && trustStatus==='approved') / AMBER (trustStatus==='pending').
- Card `opacity-70` only when red.
- Subscribe to `beacon.connected`/`beacon.disconnected` via useWebSocket().subscribe; update beacon's connected in state live.
- Keep "Last Heartbeat" row (informational) but stop using it for status.

### Step 6 — src/pages/beacon-detail.tsx
- Replace isOnline heartbeat with `beacon.connected ?? false`, same 3-color dot + pending-amber.
- (Optional but cheap) subscribe to same events to update dot live.

## Tests
### Step 7 — Coordinator tests
- test/beacon-ws.test.ts: extend for liveness — fake ws, assert ping sent, isAlive toggles on pong; non-responding conn terminated (capture .terminate()) + publishes beacon.disconnected; connect publishes beacon.connected (observe ws-pubsub publish).
- test/routes/beacons.test.ts: register beacon → GET /beacons + /:id include connected===false; _registerTestConnection → connected===true.

### Step 8 — UI tests
- New src/pages/topology.test.tsx: green/red/amber dots from connected+trustStatus combinations (not heartbeat); live event subscription updates dot.
- New src/pages/beacon-detail.test.tsx: same for detail dot.
- Follow existing patterns (MockWebSocket stub, AuthProvider+WebSocketProvider wrapper, jsonResponse helper) from sessions.test.tsx / trust.test.tsx.

## Validation criteria
- LSP diagnostics clean (typescript), including new files.
- `pnpm -r run build` passes.
- `pnpm -r run lint` passes (eslint + prettier).
- Coordinator tests: `pnpm --filter drone-coordinator test`.
- UI tests: `pnpm --filter drone-coordinator-ui test`.
- Manual: connected beacon → green; stop beacon → red live (no refresh); pending beacon → amber.

## Key facts verified during planning
- `@fastify/websocket` WebSocket aliases the `ws` package → has .ping()/.pong()/.isAlive/.terminate(); ws auto-pongs.
- No app-level or protocol-level ping currently on the reverse channel → half-open socket would show connected forever (hence Q6 hardening).
- registerBeaconWebSocket(app) is always called in buildApp (index.ts:373) → isBeaconConnected reliable on both primary and web app instances.
- Coordinator GET /beacons returns flat objects {...b, trustStatus, publicKey, verificationCode} → adding `connected` is a flat addition.
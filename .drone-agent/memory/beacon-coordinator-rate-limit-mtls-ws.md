---
key: beacon-coordinator-rate-limit-mtls-ws
tags:
  - plan
  - security
  - beacon
  - coordinator
  - rate-limit
  - mtls
  - websocket
created: 2026-08-12T18:09:51.581Z
updated: 2026-08-12T18:09:51.581Z
---

# Plan: Harden beacon & coordinator REST surfaces (rate limiting + mTLS + WS reverse channel)

## Summary

Github CodeQL flagged missing rate limiting on beacon/coordinator REST endpoints. Investigation revealed deeper exposure: beacon binds 0.0.0.0 with NO auth on any REST endpoint (only agent WS enforces local-only); coordinator primary port (3456) is UNAUTHENTICATED inbound — stored beacon public keys never verify signatures, TLS is server-side only (no client cert verification). This plan closes all three gaps:

1. Rate limiting on both services (configurable, permissive defaults).
2. Beacon hardening: default 127.0.0.1, tighten agent WS local-only, eliminate inbound surface by moving coordinator→beacon spawn/message calls onto a WebSocket reverse channel (C1).
3. Coordinator hardening: HTTPS by default + mTLS — coordinator requests beacon TLS client cert and pins fingerprint against beacon_trust.tls_fingerprint (already OOB-verified via bidirectional verification code).

## Confirmed design decisions

- Rate limits: CLI flags --rate-limit-max <n> + --rate-limit-window-ms <n> on both services, permissive defaults (e.g. 1000 req/min/IP), /health included.
- Beacon default host: 127.0.0.1; agent WS isLocalConnection tightened to loopback + own interfaces (drop 192.168.x/10.x/172.16.x).
- Coordinator primary port: HTTPS by default; mTLS with beacon TLS client-cert fingerprint pinning; /health exempt from mTLS but still rate-limited.
- WS reverse channel (C1): beacon opens outbound WS to coordinator; coordinator pushes spawn/message commands down it; mTLS authenticates connection (client-cert fingerprint → beaconId). Existing beacon→coordinator HTTP (coordinator-client.ts) stays as-is.
- WS client: use `ws` library (already transitive dep via @fastify/websocket) NOT built-in Node WebSocket (built-in client doesn't support client certs).

## Phase 1 — Rate limiting (both services)

1.1 Add @fastify/rate-limit to drone-beacon/package.json and drone-coordinator/package.json deps.
1.2 drone-beacon/src/index.ts: add rateLimitMax (default 1000) + rateLimitWindowMs (default 60000) to Config + parseArgs() with --rate-limit-max/--rate-limit-window-ms; register plugin after fastify() creation; add to --help.
1.3 drone-coordinator/src/index.ts: same flags + registration inside buildApp() (so tests get it); add to --help.
1.4 Tests: beacon test/routes.test.ts + coordinator test (rate-limit.test.ts or health.test.ts) assert 429 after exceeding limit.
1.5 Update both README.md option tables.

## Phase 2 — Beacon default host + tighten agent WS

2.1 drone-beacon/src/index.ts: DEFAULT_HOST 0.0.0.0 → 127.0.0.1; update --help + README.
2.2 drone-beacon/src/ws-server.ts: tighten isLocalConnection to loopback (127.0.0.1, ::1, ::ffff:127.0.0.1) + machine's own interface addresses (reuse networkInterfaces() approach from web-auth.ts); remove private-LAN ranges.
2.3 drone-beacon/test/ws-server.test.ts: update — private-LAN IPs now false; loopback + own-interface IPs true.

## Phase 3 — Coordinator HTTPS by default + mTLS

3.1 drone-coordinator/src/index.ts: useHttps default true (drop COORDINATOR_HTTPS env gate; keep --no-https opt-out); extend buildApp https option with requestCert:true, rejectUnauthorized:false (self-signed; pinning manual).
3.2 New drone-coordinator/src/mtls.ts: getClientCertFingerprint(req) reads req.socket.getPeerCertificate() → SHA-256 fingerprint (lowercase, no colons); createMtlsMiddleware() onRequest hook: skips /health + POST /api/beacons (registration in-route); for other /api/\* routes resolve presented cert fingerprint against beacon_trust.tls_fingerprint, no match → 401; if HTTPS disabled log warning that primary port unauthenticated.
3.3 drone-coordinator/src/routes/beacons.ts registration handler: verify presented client-cert fingerprint equals request.body.tlsFingerprint (reject spoofed registration); on re-registration verify against stored fingerprint (TOFU pinning).
3.4 drone-beacon/src/coordinator-client.ts: extend createCoordinatorFetch to accept beacon TLS identity (certPem, keyPem) and pass cert/key into https.request options; thread through createCoordinatorClient.
3.5 drone-beacon/src/index.ts: pass loaded tlsIdentity into createCoordinatorClient options.
3.6 Docker + smoke test: docker-compose.smoke-test.yaml + integration-test.yaml coordinator runs HTTPS (default now); beacon gets --coordinator-https (or COORDINATOR_HTTPS=true); docker/smoke-test/src/index.ts COORDINATOR_URL → https://...; fetch to coordinator uses rejectUnauthorized:false (self-signed); health checks still work (exempt from mTLS).
3.7 Tests: drone-coordinator/test/mtls.test.ts (getClientCertFingerprint + middleware: valid cert pass, unknown cert 401, /health exempt, registration exempt); drone-coordinator/test/routes/beacons.test.ts (registration rejects mismatched client-cert fingerprint); drone-beacon/test/coordinator-client.test.ts (assert https.request called with cert/key).

## Phase 4 — WS reverse channel (C1)

4.1 New drone-coordinator/src/beacon-ws.ts: registerBeaconWebSocket(app) — GET /ws/beacon websocket route on primary port (covered by mTLS); resolve beaconId from client-cert fingerprint; register beaconId→socket in map; handle {type:'response',id,...} resolving pending request promises; remove on close. sendBeaconCommand(beaconId, command, payload): if connected send {type:'command',id,command,payload} return promise resolved by matching response (timeout → reject → caller returns 503).
4.2 drone-coordinator/src/routes/spawn.ts: replace fetch(buildBeaconUrl(...)) with sendBeaconCommand(beaconId, 'spawn'|'listSpawns'|'getSpawn'|'terminateSpawn', ...); keep same HTTP status mapping (404/502/503).
4.3 drone-coordinator/src/routes/messages.ts: replace fetch(.../messages) with sendBeaconCommand(beaconId, 'deliverMessage'|'broadcastMessage', ...).
4.4 New drone-beacon/src/coordinator-ws.ts: ws-based client connecting to ws(s)://<coordinator>/ws/beacon presenting beacon TLS client cert; on {type:'command',id,command,payload} dispatch to handlers and reply {type:'response',id,ok,status,body}; reconnect with backoff on close/error.
4.5 drone-beacon/src/routes/spawn.ts + messages.ts: extract core handler logic (spawn/list/get/terminate; deliver/broadcast) into exported functions so both REST routes and WS command handlers reuse (no duplication).
4.6 drone-beacon/src/index.ts: start WS client after coordinator client created (only when coordinator configured).
4.7 Tests: drone-coordinator/test/beacon-ws.test.ts (connection registry, command send + response correlation, timeout → 503); drone-coordinator/test/routes/spawn.test.ts + messages.test.ts (assert commands sent over WS, mock sendBeaconCommand, instead of fetch); drone-beacon/test/coordinator-ws.test.ts (command dispatch + response, reconnect logic); drone-beacon/test/routes/spawn.test.ts + messages.test.ts (extracted handlers still work via REST).

## Phase 5 — Validation

5.1 pnpm -r run build (after any drone-core/drone-swarm-common type changes) so dependent packages resolve fresh dist/.
5.2 pnpm -r run typecheck — zero errors.
5.3 pnpm -r run lint — zero errors (prettier reformats; re-read files before further edits).
5.4 pnpm -r run test — fast suite passes.
5.5 Run docker smoke test (pnpm docker:smoke-test) to confirm HTTPS+mTLS+WS topology end-to-end.
5.6 LSP diagnostics clean across all touched files.

## Validation criteria

- LSP passes with zero errors on all touched files.
- pnpm -r run typecheck, lint, build all pass with zero errors.
- pnpm -r run test (fast suite) passes; new tests cover: rate limiting (429), mTLS pinning (401 on unknown cert, registration fingerprint check), WS reverse-channel command/response, tightened isLocalConnection, extracted spawn/message handlers.
- Docker smoke test passes with HTTPS+mTLS+WS topology.
- Beacon defaults to 127.0.0.1; agent WS rejects private-LAN IPs.
- Coordinator primary port defaults to HTTPS; /health exempt from mTLS but rate-limited.

## Notes

- Docker smoke test currently uses plain HTTP against coordinator; Phase 3 requires updating it.
- WS reverse channel keeps beacon's local /spawn and /messages REST routes intact for local agents — only coordinator's calls move to WS.
- Key finding: coordinator primary port is NOT protected by TLS fingerprint verification inbound — that's a real gap, same gap WS handshake must close. Beacon TLS identity (beacon-cert.pem/beacon-key.pem) is the natural anchor; already OOB-verified via bidirectional verification code.

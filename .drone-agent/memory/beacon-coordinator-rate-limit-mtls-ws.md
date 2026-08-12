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
  - completed
created: 2026-08-12T18:09:51.581Z
updated: 2026-08-12T19:15:42.692Z
---

# Plan: Harden beacon & coordinator REST surfaces (rate limiting + mTLS + WS reverse channel)

## STATUS: COMPLETED (2026-08-12)

All 5 phases executed. All validation criteria pass: build, typecheck, lint, 1853 tests, LSP diagnostics clean. Docker smoke test updated but not run (no Docker daemon in environment).

## Summary of work completed

### Phase 1 — Rate limiting (both services)
- Added @fastify/rate-limit to drone-beacon and drone-coordinator package.json
- Added --rate-limit-max (default 1000) and --rate-limit-window-ms (default 60000) CLI flags to both services
- Registered the plugin in beacon's main() and coordinator's buildApp()
- Added rate-limit tests (429 after exceeding limit) for both packages
- Updated both README option tables

### Phase 2 — Beacon default host + tighten agent WS
- Changed beacon DEFAULT_HOST from 0.0.0.0 to 127.0.0.1
- Tightened isLocalConnection in ws-server.ts: removed private-LAN ranges (192.168.x, 10.x, 172.16.x, 169.254.x), now only loopback + machine's own network interfaces
- Updated ws-server.test.ts: private-LAN IPs now return false, added own-interface test
- Updated beacon Dockerfile to pass --host 0.0.0.0 (needed for Docker networking)
- Fixed latent readyState === 'OPEN' bug (should be numeric 1) surfaced by @types/ws

### Phase 3 — Coordinator HTTPS by default + mTLS
- Changed coordinator useHttps default to true (dropped COORDINATOR_HTTPS env gate; kept --no-https opt-out)
- Extended buildApp https option with requestCert: true, rejectUnauthorized: false
- New drone-coordinator/src/mtls.ts: getClientCertFingerprint(), resolveBeaconIdByFingerprint(), createMtlsMiddleware() — exempts /health and POST /api/beacons, pins client cert fingerprint against beacon_trust.tls_fingerprint for all other /api/* routes
- beacons.ts registration handler: verifies presented client-cert fingerprint matches request.body.tlsFingerprint (spoofing prevention)
- coordinator-client.ts: extended createCoordinatorFetch to accept tlsIdentity and pass cert/key into https.request options
- beacon index.ts already passed tlsIdentity to createCoordinatorClient (was already wired)
- Updated docker-compose files: coordinator runs HTTPS (default), beacon gets COORDINATOR_HTTPS=true, smoke-test runner uses https:// + NODE_TLS_REJECT_UNAUTHORIZED=0
- New mtls.test.ts (10 tests): fingerprint extraction, beacon resolution, middleware exemptions, 401 on unknown cert
- coordinator-client.test.ts: new test asserting https.request called with cert/key

### Phase 4 — WS reverse channel (C1)
- New drone-coordinator/src/beacon-ws.ts: registerBeaconWebSocket() — GET /ws/beacon on primary port (mTLS-protected), resolves beaconId from client cert, stores beaconId→socket map, handles response messages resolving pending command promises. sendBeaconCommand() sends command over WS, returns promise resolved by matching response (timeout → reject → 503).
- Coordinator spawn.ts and messages.ts: replaced fetch(buildBeaconUrl(...)) with sendBeaconCommand(), preserving HTTP status mapping (404/502/503)
- New drone-beacon/src/coordinator-ws.ts: ws-based client connecting to ws(s)://coordinator/ws/beacon with beacon TLS client cert, dispatches commands to shared handlers, replies with responses, reconnects with exponential backoff
- Extracted beacon spawn/message handler logic into spawn-handlers.ts and message-handlers.ts (shared by REST routes and WS command handlers — no duplication)
- Beacon index.ts: starts WS client after coordinator client is created
- New beacon-ws.test.ts (6 tests): command send + response correlation, timeout, send error, connection registry
- Updated coordinator spawn.test.ts and messages.test.ts to mock sendBeaconCommand instead of fetch

### Phase 5 — Validation
- pnpm -r run build: zero errors
- pnpm typecheck: zero errors
- pnpm lint: zero errors (prettier reformatted some files)
- pnpm test: 1853 passed, 9 skipped, 0 failed
- LSP diagnostics: zero errors on all touched files
- Docker smoke test: compose files and smoke test source updated (not run — no Docker daemon)

## Files created
- drone-coordinator/src/mtls.ts
- drone-coordinator/src/beacon-ws.ts
- drone-beacon/src/coordinator-ws.ts
- drone-beacon/src/routes/spawn-handlers.ts
- drone-beacon/src/routes/message-handlers.ts
- drone-beacon/test/rate-limit.test.ts
- drone-coordinator/test/rate-limit.test.ts
- drone-coordinator/test/mtls.test.ts
- drone-coordinator/test/beacon-ws.test.ts

## Commits (on feat/beacon-coordinator-rate-limit-mtls-ws branch)
1. Add plan: beacon/coordinator rate limit + mTLS + WS reverse channel
2. Phase 1: Add configurable rate limiting to beacon and coordinator
3. Phase 2: Beacon default host 127.0.0.1 + tighten agent WS local-only
4. Phase 3: Coordinator HTTPS-by-default + mTLS client-cert fingerprint pinning
5. Phase 4: WS reverse channel + extracted spawn/message handlers
6. Phase 5: Lint/format pass — all validation criteria green
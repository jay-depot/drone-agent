---
tags: [decision, security, swarm]
related: [swarm-architecture.md, drone-beacon.md, drone-coordinator.md, concepts/mtls-and-reverse-channel.md, decisions/117-tofu-fingerprint-pinning.md, decisions/122-tofu-fingerprint-pin-socket-secureconnect.md, decisions/025-coordinator-web-ui-http-port.md, decisions/043-inter-beacon-spawn-routing.md, flows/swarm-connection.md]
---

# Rate Limiting + mTLS + WS Reverse Channel

**Summary**: Hardened the beacon and coordinator REST surfaces with configurable rate limiting, changed the beacon default bind to localhost, made the coordinator primary port HTTPS-by-default with mTLS client-cert fingerprint pinning, and eliminated the beacon's inbound REST exposure by moving coordinator→beacon spawn/message calls onto a WebSocket reverse channel.

## Context

GitHub's CodeQL security scan flagged missing rate limiting on the beacon and coordinator REST endpoints. Investigation revealed deeper exposures:

1. **Beacon** bound to `0.0.0.0` with **no auth** on any REST endpoint — only its agent WebSocket enforced local-only. All REST routes (`/spawn`, `/config`, `/memory`, `/messages`, `/agents`, etc.) were wide open to anyone who could reach the port.
2. **Coordinator primary port** (3456) was **unauthenticated inbound** — the stored beacon public keys were never used to verify signatures, and TLS was server-side only (no client cert verification). The only "verification" in the chain was the beacon trusting the coordinator (TOFU), never the other way around.
3. The beacon's `isLocalConnection` allowed private-LAN ranges (192.168.x, 10.x, 172.16.x) — a leftover from when remote beacons were planned.

## Decision

Three coordinated hardening efforts:

### 1. Rate Limiting

Added `@fastify/rate-limit` to both services with configurable CLI flags (`--rate-limit-max`, `--rate-limit-window-ms`) and permissive defaults (1000 req/min/IP). `/health` is rate-limited but exempt from mTLS so health checks and the smoke test work without a client cert.

### 2. Beacon Hardening

- Default bind changed from `0.0.0.0` to `127.0.0.1` (secure-by-default; Docker passes `--host 0.0.0.0` explicitly).
- `isLocalConnection` tightened to loopback + the machine's own network interfaces (dropped private-LAN ranges since remote beacons are not supported).

### 3. Coordinator HTTPS-by-default + mTLS

- Coordinator primary port now defaults to HTTPS (`useHttps: true`; `--no-https` opt-out).
- Server requests client certificates (`requestCert: true`, `rejectUnauthorized: false` — self-signed certs; pinning is manual).
- New `mtls.ts` middleware: reads the presented client cert's SHA-256 fingerprint, resolves it against `beacon_trust.tls_fingerprint` (already OOB-verified via the bidirectional verification code), and rejects unauthenticated requests with 401. Exempts `/health` and `POST /api/beacons` (registration is verified in-route).
- Beacon registration handler verifies the presented client-cert fingerprint matches `request.body.tlsFingerprint` (spoofing prevention).
- Beacon's `createCoordinatorFetch` now passes `cert`/`key` into `https.request` options for mTLS.

### 4. WS Reverse Channel (C1)

The beacon opens an **outbound** WebSocket to the coordinator's `/ws/beacon` endpoint (mTLS-authenticated). The coordinator pushes spawn/message commands down this channel via `sendBeaconCommand()`, eliminating the need for inbound HTTP calls to the beacon. This is the "reverse channel" pattern — the beacon maintains the connection, the coordinator sends requests over it.

- **Coordinator side** (`beacon-ws.ts`): `registerBeaconWebSocket()` registers `/ws/beacon` on the primary port; resolves beaconId from the client cert fingerprint; stores `beaconId → socket` map; `sendBeaconCommand()` sends a command and returns a promise resolved by the matching response (with a timeout).
- **Beacon side** (`coordinator-ws.ts`): `ws`-based client connecting to `wss://coordinator/ws/beacon` with the beacon's TLS client cert; dispatches commands to shared handlers; reconnects with exponential backoff.
- **Shared handlers**: spawn and message handler logic extracted into `spawn-handlers.ts` and `message-handlers.ts` so both the REST routes and the WS command dispatchers reuse the same code — no duplication.
- The `ws` library was used (not Node's built-in WebSocket) because the built-in client doesn't support client certificates.

## Tradeoffs

- **HTTPS-by-default** is a breaking change for existing HTTP deployments. Operators must use `--no-https` or update their clients. This was deemed acceptable given the security improvement.
- **mTLS requires the beacon's TLS identity** to be registered and trusted. The OOB verification flow (bidirectional verification code) already covers this — the fingerprint is one of the three inputs to the code, already compared by a human.
- **WS reverse channel** adds a persistent connection and command/response correlation with timeouts. The coordinator's spawn/message routes now return 503 when the beacon is not connected (previously 503 on fetch failure — same semantics).
- The beacon's local `/spawn` and `/messages` REST routes are kept intact for local agents — only the coordinator's calls moved to WS.

## Key Points

- Rate limits are configurable but permissive (1000/min) — this is a single-user swarm, not a public API.
- `/health` is exempt from mTLS but still rate-limited, so health checks work without a client cert.
- The mTLS middleware only runs when `enableMtls` is set on `buildApp()` (primary port only, not the web port).
- The `ws` package was added as a direct dependency to `drone-beacon` (was only a transitive dep via `@fastify/websocket`).
- Adding `@types/ws` surfaced a latent bug: `readyState === 'OPEN'` should be `readyState === 1` (numeric).

## Related

- [[concepts/mtls-and-reverse-channel]] — The mTLS + reverse channel concept page
- [[swarm-architecture]] — Swarm mode security section
- [[modules/drone-beacon]] — Beacon module (updated)
- [[modules/drone-coordinator]] — Coordinator module (updated)
- [[flows/swarm-connection]] — Connection flow (updated)
- [[decisions/117-tofu-fingerprint-pinning]] — TOFU fingerprint pinning (beacon → coordinator)
- [[decisions/122-tofu-fingerprint-pin-socket-secureconnect]] — Socket secureConnect fix
- [[decisions/025-coordinator-web-ui-http-port]] — Dual-port architecture
- [[decisions/043-inter-beacon-spawn-routing]] — Inter-beacon spawn routing (now via WS)
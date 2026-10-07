---
tags: [decision, swarm, websocket, transport, security]
related: [decisions/123-rate-limit-mtls-ws-reverse-channel.md, concepts/mtls-and-reverse-channel.md, concepts/memory-pipeline.md]
---

# 177: Coordinator→beacon commands via reverse channel with HTTP fallback

**Status**: Implemented (2026-08-29, branch `fix/coordinator-spawn-over-reverse-channel`); merged to `main` via PR #85 (squash `e348865`, 2026-08-30)

## Context

ADR 123 introduced the coordinator→beacon WS reverse channel (`beacon-ws.ts` / `coordinator-ws.ts`, `sendBeaconCommand`) and migrated the coordinator's spawn API routes plus message relay off of inbound HTTP. One coordinator→beacon call site remained on direct HTTP: the **session-end spawn trigger** (`drone-coordinator/src/session-end.ts`), which `POST /spawn`ed to `http://<beacon.host>:<beacon.port>/spawn` when a swarm session was marked ended.

That path violated the design principle the reverse channel exists to establish — the coordinator never needs an inbound connection to a beacon — and it also carried an mTLS gap: the fallback URL hardcoded `http://` even when the beacon served HTTPS.

Separately, the integration test infrastructure required unattended beacon enrollment. Three trust gates were human-only:
1. Coordinator approves a registering beacon (trust rows start `pending`).
2. Beacon confirms the coordinator's TLS fingerprint (TOFU compare-only handshake).
3. The test-runner itself needed coordinator API access that only beacon-held client certs satisfy.

## Decision

1. **Session-end spawn is reverse-channel-first.** `runSpawnTrigger` checks `isBeaconConnected(beaconId)` and pushes the spawn via `sendBeaconCommand(beaconId, 'spawn', payload, 10_000)`. On a transport failure (not connected, send error, timeout) it logs and falls back to the legacy direct-HTTP `POST /spawn`. On an **app-level** failure response (`!res.ok` — e.g. persona not found) it returns the error immediately **without** the HTTP retry: the request already reached the beacon, and a retry could duplicate the spawn.

2. **`autoApproveBeacons: true` (coordinator config-file key).** New trust registrations start `approved` instead of `pending`. Off by default; settable only via `--config-file`. The mTLS anti-spoof check (presented client cert must match the claimed `tlsFingerprint`) is unaffected.

3. **`BEACON_AUTO_CONFIRM_COORDINATOR_FINGERPRINT=true` (beacon env).** After a registration that returns `approved`, the beacon confirms the pending coordinator fingerprint it observed on the registration connection itself — the TOFU basis in an unattended swarm. Off by default. Pairs with #2: the coordinator still verifies the beacon's cert, so both halves of the gate are closed without a human.

4. **Composed integration swarm.** `docker/coordinator.config.json` (sessionEnd spawn trigger → fixed beacon ID `beacon-teste2e` + `autoApproveBeacons`), fixed beacon ID via compose `command`, auto-confirm env on the beacon, and a new integration suite (`drone-agent/test/swarm-reverse-channel.test.ts`) that drives all coordinator-facing calls through the beacon's coordinator proxy — the correct trust boundary, since only the beacon holds coordinator-facing mTLS credentials.

## En-route fixes the integration work forced

- **Beacon env config**: `COORDINATOR_HOST`/`COORDINATOR_PORT` were declared in the beacon's `Config` but never read from the environment (CLI-only). Docker compose values were silently dead; the isolated integration swarm had *never* had a live beacon↔coordinator link before this.
- **Outbox flusher mTLS**: the flusher's `createCoordinatorFetch(baseUrl)` presented no client cert, so every outboxed fire-and-forget write (session register/end, events push, persona/skill sync) was rejected 401 by the mTLS coordinator. The flusher now carries the beacon TLS identity and TOFU pin.
- **FST_ERR_CTP_EMPTY_JSON_BODY in the flusher**: unconditional `Content-Type: application/json` on bodyless DELETEs (the Category-5 fix that never reached the flusher path).
- **`@types/ws` + readyState duality**: with `@types/ws` in the tree, `WebSocket.readyState` is numeric-only; the ADR-174 dual numeric/string `OPEN` check needed an explicit `unknown`-typed local to compile while keeping the defensive runtime check.

## Consequences

- The coordinator's last inbound HTTP call to beacons is now a fallback, not the primary path. `POST /api/spawn` (the API route) has **no** HTTP fallback by design.
- Transport choice is observable per attempt in the coordinator log (`via reverse channel` vs no marker on the fallback path).
- Production deployments change nothing: both opt-ins default off, and the fallback preserves behavior for beacons that never connect their reverse channel.
- The integration suite now proves the full circuit live (TLS → mTLS → reverse-channel command → spawn record), and documents — rather than hides — the spawned-agent LLM wiring gap (see project memory `spawned-agent-llm-wiring`).

## Related

- [[decisions/123-rate-limit-mtls-ws-reverse-channel]] — the original reverse-channel design
- [[concepts/mtls-and-reverse-channel]] — mechanism reference (updated: session-end trigger is reverse-channel-first)
- [[concepts/memory-pipeline]] — config-file keys (updated with `autoApproveBeacons`) and outbox flusher mTLS
- [[flows/swarm-connection]] — connection flow (updated)
- Project memory `pre-existing-integration-failures` — the remaining integration debt
---
key: pre-existing-integration-failures
tags:
  []
created: 2026-08-29T23:24:56.646Z
updated: 2026-08-30T00:27:20.854Z
---

# Integration failures: RESOLVED 2026-08-29 (commit 7eda0f0, PR #85)

## Status: all four known failures fixed and verified green in Docker

1. **coordinator-sync GET 401s (3 tests)** — FIXED: `getCoordinatorPersonas`/`getCoordinatorSkills` now read through the beacon's coordinator proxy (new routes `GET /coordinator/personas|skills` in drone-beacon/src/routes/coordinator.ts, served over the beacon's mTLS client via `fetchPersonas()`/`fetchSkills()`). Helpers take `beaconUrl` explicitly; coordinator-sync call sites pass BEACON_URL. Result: coordinator-sync 6/6.
2. **e2e-swarm full-agent-lifecycle staleness (1 test)** — FIXED: the test registered its OWN agent (`e2e-lifecycle-agent` via `registerBeaconAgent`) and asserts freshness against that agent's record only, instead of wall-clock-checking whatever 'connected' rows earlier suites left behind. Result: e2e-swarm 4/4.

## Still-open root cause (upstream of both, NOT fixed)

Spawned agents are never cleaned out of `agent_sessions` (rows stay `status:'connected'`, `lastActivity` frozen at spawn) because they crash without an LLM provider before any real heartbeat — see memory `spawned-agent-llm-wiring`. The zombie rows are why the freshness assertion failed and why 'connected' sets are untrustworthy generally. Real fix options: (a) beacon ties agent_sessions lifecycle to spawn process lifecycle (remove/deactivate row on exit), (b) an aggressive stale-marking sweep in the beacon, or (c) fix the LLM wiring so spawned agents actually live. The tests now tolerate the zombies, but the ledger is still lying.

## Context from the original isolation work (2026-08-15..17)

`pnpm test:integration` runs vitest INSIDE the test-runner container (never on host); all 5 swarm suites + subagent dispatch are gated by `shouldSkipIntegrationSuite()` via `describe.skipIf(...)`. Categories 1-5 of that era were fixed per the earlier version of this memory; note Category 5 (FST_ERR_CTP_EMPTY_JSON_BODY) had a regression in the outbox flusher that was fixed 2026-08-29 (commit 3dee794).
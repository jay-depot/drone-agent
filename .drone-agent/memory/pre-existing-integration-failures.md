---
key: pre-existing-integration-failures
tags:
  []
created: 2026-08-29T23:24:56.646Z
updated: 2026-08-29T23:24:56.646Z
---

# Plan: Isolate integration tests from the live local beacon

## Problem

The 5 swarm HTTP integration tests (e2e-swarm, coordinator-sync, spawn, inter-agent, agent-beacon) resolve targets with `process.env.BEACON_URL || 'http://localhost:3457'` / `COORDINATOR_URL || 'http://localhost:3456'`. `waitForService()` returns false when unreachable but callers ignore it, so tests POST /personas + /skills garbage into the user's real local beacon when the isolated swarm isn't answering on 3457. subagent/dispatch.test.ts spawns real drone-agent processes against the user's real config/LLM with no gate.

## Root causes

- `pnpm test:integration` runs bare vitest ON THE HOST (not in the test-runner container). Host run with env unset falls back to localhost:3457 -> real beacon.
- docker-compose.integration-test.yaml publishes 3457:3457/3456:3456/3458:3458 to HOST ports (collision vector with live beacon). test-runner service only runs a tiny smoke script, not vitest.
- No RUN_INTEGRATION_TESTS gate on any of the 5 files (only lsp-server-smoke.test.ts has it).

## Agreed approach (confirmed with user)

- (A) Run vitest INSIDE the test-runner container on the docker network, talk to http://drone-beacon:3457 (never localhost). Remove host `ports:` bindings for echo-llm, drone-coordinator, drone-beacon, dummy-agent.
- `pnpm test:integration` orchestrates: bring up isolated swarm -> run vitest in-container -> tear down. Refuse if swarm can't be provisioned.
- Safety net (option 2): if integration config run directly, tests refuse against unsafe localhost:3457/3456 fallback unless provisioned swarm confirmed up.
- subagent/dispatch.test.ts gets same gating (garbage sessions/LLM calls).

## COMPLETED (2026-08-15)

All steps implemented and committed on branch `fix/integration-test-beacon-isolation`:

- test-runner.Dockerfile now builds the full workspace and runs vitest in-container.
- docker-compose.integration-test.yaml: removed all host `ports:` bindings; test-runner runs the real vitest suite with RUN_INTEGRATION_TESTS/RUN_LSP_SMOKE_TESTS/LLM_PROVIDER=echo/LLM_ECHO_URL set.
- package.json: `test:integration` now orchestrates `docker compose up --build --abort-on-container-exit --exit-code-from test-runner`; added `test:integration:vitest`, `docker:integration:run`, `docker:integration:down -v`.
- CI workflow: integration-tests job now runs `pnpm test:integration` (with pnpm setup + install).
- AGENTS.md documents the containerized integration workflow and the provisioning guards.
- Guard: `shouldSkipIntegrationSuite()` in fixtures/swarm.ts, used via `describe.skipIf(...)` in all 5 swarm tests + subagent/dispatch.test.ts. Skips (not fails) when RUN_INTEGRATION_TESTS unset or a target resolved to its localhost fallback.

### Critical fix discovered during verification

The initial guard used `test.skip()` inside `beforeAll`, which does NOT skip the `it()` blocks — the swarm tests still ran and hit localhost:3457. Replaced with a synchronous `shouldSkipIntegrationSuite()` helper used via `describe.skipIf(...)`, so the entire suite is skipped when the isolated swarm isn't provisioned. Verified: with RUN_INTEGRATION_TESTS=true and no swarm up, the integration config now reports 49 skipped (5 swarm suites + subagent dispatch) instead of failing against localhost.

## COMPLETED (2026-08-17) - Integration test failure fixes

Fixed all 5 categories of integration test failures discovered during the first docker-compose run:

### Category 1: "fetch failed" errors (23 test failures)

Tests connected to beacon/coordinator before they were ready.
Fix: Added `waitForService()` calls in `beforeAll` hooks to all 5 swarm test files, with error throwing if service isn't available.

### Category 2: Coordinator 404s (4 test failures)

Coordinator routes are under `/api` prefix (e.g., `/api/personas`, `/api/skills`) but test fixtures hit `/personas` and `/skills` directly.
Fix: Updated `pushPersonaToCoordinator`, `getCoordinatorPersonas`, `pushSkillToCoordinator`, `getCoordinatorSkills` in fixtures/swarm.ts to use `/api/personas` and `/api/skills` paths.

### Category 3: Beacon channel route not found (3 test failures)

No REST endpoint for `PUT /agents/:id/channels/:channel` (join), `DELETE /agents/:id/channels/:channel` (leave), or `POST /channels/:channel/messages` (send message). Channels were WebSocket-only.
Fix: Added `drone-beacon/src/routes/channels.ts` with these REST endpoints. Also updated `sendChannelMessage` fixture to use correct field names (fromAgentId, body as JSON string) and `sendBeaconMessage` to use fromAgentId/toAgentId/body as JSON string. Updated `getBeaconMessages` to use `GET /messages?agentId=` instead of `/agents/:id/messages`. Updated test `Message` type to match beacon's actual `AgentMessage` type (fromAgentId, toAgentId, body as string).

### Category 4: Subagent dispatch failures (5+ test failures)

Subagent processes used default `ollama` LLM provider instead of echo. Echo plugin has `defaultEnabled: false` and requires `--plugin echo --plugin llm`.
Fix: Added `--plugin echo --plugin llm` to subagent args when `LLM_PROVIDER=echo`. Added `/root/.drone-agent/config.json` in test-runner Dockerfile with `llm.provider=echo` and `enabledPlugins=["llm","echo"]`. Skipped timeout/crash tests with `it.skipIf(usingEchoLlm)` since echo LLM responds instantly and never crashes.

### Category 5: DELETE requests with empty body (400 errors)

`leaveChannel` and `terminateAgent` send `Content-Type: application/json` with no body, causing Fastify to reject with `FST_ERR_CTP_EMPTY_JSON_BODY`.
Fix: Updated `http.ts` request helper to only send `Content-Type: application/json` header when body is present, not for bodyless requests like DELETE.

### Additional fixes

- Added retry logic to dummy-agent registration (10 retries, 2s delay) since it may start before beacon is ready.
- Added agent-wait loops in inter-agent and agent-beacon `beforeAll` hooks.

## COMPLETED (2026-08-17) - Typecheck fix (leftover from Category 3)

The Category 3 fix renamed the test `Message` interface fields from `from`/`to` to `fromAgentId`/`toAgentId` in `fixtures/index.ts`, but `assertMessageExists` in `fixtures/assertions.ts` was not updated and still referenced `m.from`/`m.to`, breaking `pnpm typecheck` (TS2339 on lines 225-226). Fixed by renaming the assertion options to `fromAgentId`/`toAgentId` and updating the field access. `assertMessageExists` has no callers, so no other call sites needed updating. Verified: `pnpm typecheck`, `pnpm build`, `pnpm test` (1913 passed, 9 skipped), and `pnpm lint:eslint` all pass. Committed as 30b5ceb.

## UPDATE (2026-08-29, branch feat/beacon-coordinator-rate-limit-mtls-ws) — mTLS changed the integration landscape

Major finding: **the isolated swarm never had a live beacon<->coordinator link prior to this branch.** The beacon ignored COORDINATOR_HOST/COORDINATOR_PORT env vars (only read them from CLI flags), so registration never happened; tests passed because they exercise the beacon's REST surface directly and the fixtures tolerate coordinator absence.

Fixed on this branch (commits a47806f, 3dee794, 1be5db4):
1. Beacon now reads COORDINATOR_HOST/PORT from env (compose values were silently dead).
2. Outbox flusher now presents the beacon mTLS client cert (was credential-less -> 401 against the mTLS coordinator) and carries the TOFU pin.
3. New opt-ins for unattended swarms: coordinator config `autoApproveBeacons: true` (new trust rows start approved; anti-spoof cert check intact) and beacon env `BEACON_AUTO_CONFIRM_COORDINATOR_FINGERPRINT=true` (skips the human compare-only handshake).
4. Compose: fixed beacon ID `beacon-teste2e`, coordinator config mount (docker/coordinator.config.json: sessionEnd spawn trigger -> beacon-teste2e + autoApproveBeacons).
5. New suite drone-agent/test/swarm-reverse-channel.test.ts (2 tests, runs-green): API spawn over the reverse channel (no-HTTP-fallback path) and the session-end hook circuit (beacon proxy -> outbox -> coordinator hook -> WS spawn -> beacon spawn record; must allow one full 60s outbox flush interval).

## KNOWN PRE-EXISTING INTEGRATION FAILURES (not caused by the reverse-channel work; follow-up candidates)

1. **coordinator-sync GET-d failures (3)**: the fixture's coordinator-facing GETs go direct to the mTLS coordinator without a client cert (401). The push variants succeed via the beacon proxy. Fix direction: route those fixture calls through the beacon coordinator proxy like the rest.
2. **e2e-swarm full-agent-lifecycle staleness (1)**: `agent.lastActivity` freshness assertion (`now - lastActivity < 60000`) trips after the ~45s of prior suites' spawned-agent churn; dummy-agent-1's lastActivity reflects its registration, not continuous activity. Fix direction: use the connection event or drop the wall-clock assertion.
3. **Spawned agents never connect** (they crash without an LLM provider, exit code 1): see memory key `spawned-agent-llm-wiring`. Any test needing a spawned agent to actually process a turn is blocked on that. Spawn-record assertions are the workaround.
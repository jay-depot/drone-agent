---
key: plan-integration-test-beacon-isolation
tags:
  - plan
  - integration-test
  - isolation
  - regression
  - docker
  - beacon
created: 2026-08-14T21:23:53.070Z
updated: 2026-08-17T00:10:26.994Z
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

## Key facts
- LLM broker auto-activates provider matching config.llm.provider (default 'ollama'). In-container agent config must set llm.provider="echo", enable echo plugin, LLM_ECHO_URL=http://echo-llm:3458.
- resolveDroneExecutable (drone-core/src/utils.ts:148) uses PATH + fallbackArgv1(process.argv[1]); needs drone-agent bin on PATH in container.
- echo plugin (drone-agent/src/plugins/echo/index.ts:87) reads LLM_ECHO_URL (default localhost:3458).
- waitForService: drone-agent/test/fixtures/swarm.ts:20-37 returns false, callers ignore.
- createBeaconPersona->POST /personas (fixtures/swarm.ts:150-156); pushPersonaToCoordinator->POST /personas (342-348); pushSkillToCoordinator->POST /skills (364-370).
- vitest.config.ts excludes the 5 files + subagent/dispatch. vitest.integration.config.ts includes them + mcp.test.ts + lsp-server-smoke.test.ts.
- package.json: test:integration = "RUN_INTEGRATION_TESTS=true RUN_LSP_SMOKE_TESTS=true vitest run -c vitest.integration.config.ts". docker:integration:test = compose up && test:integration && compose down (&& short-circuit breaks if up fails).
- .github/workflows/integration-test.yml integration-tests job: docker compose build + `docker compose up --abort-on-container-exit`.
- test-runner.Dockerfile currently node:22-alpine copying only docker/test-runner (tiny smoke). Needs to become full-workspace vitest runner.

## Files to change
- docker/test-runner.Dockerfile (full workspace + vitest + CMD)
- docker/docker-compose.integration-test.yaml (remove host ports, test-runner runs vitest, depends_on healthy)
- package.json scripts (test:integration orchestrates docker; keep docker:integration:up/down)
- .github/workflows/integration-test.yml (use pnpm test:integration)
- drone-agent/test/fixtures/swarm.ts (add provisioning guard helper)
- drone-agent/test/{e2e-swarm,coordinator-sync,spawn,inter-agent,agent-beacon}.test.ts (wrap with guard)
- drone-agent/test/subagent/dispatch.test.ts (wrap with guard)
- Possibly a config file mounted into test-runner container for echo LLM (llm.provider=echo, enabledPlugins echo, LLM_ECHO_URL)
- docs (AGENTS.md / docs/agents) describing the integration test workflow

## Validation
- LSP pass, pnpm -r lint + build zero errors, fast test suite passes.
- Run `pnpm test:integration` with a real beacon NOT running on host 3457: must bring up isolated swarm, tests pass against it, swarm torn down, host beacon untouched.
- Run integration config directly (bypass orchestrator, env unset): tests REFUSE (fail/skip) rather than hitting localhost:3457.
- Verify /personas on a host beacon gets no test garbage after the suite.

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

### Validation results
- pnpm typecheck: pass
- pnpm lint: pass
- pnpm -r run build: pass
- pnpm test (fast suite): 1913 passed, 9 skipped
- Integration config direct run (no swarm): 21 passed (mcp + lsp-smoke), 49 skipped (swarm + subagent) — no localhost pollution
- LSP diagnostics: clean on all edited files
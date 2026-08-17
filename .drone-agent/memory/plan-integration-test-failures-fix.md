---
key: plan-integration-test-failures-fix
tags:
  - plan
  - integration-test
  - echo
  - beacon
  - subagent
  - docker
created: 2026-08-17T02:35:36.059Z
updated: 2026-08-17T02:35:36.059Z
---

# Plan: Fix the 12 failing integration tests

## Summary
The CI integration suite (`pnpm test:integration`, vitest inside isolated Docker swarm) has 12 failures across 4 files. 4 distinct deterministic root causes (not flaky). Fixing unblocks the merge.

## Root causes & fixes
| # | Root cause | Tests affected | Fix |
|---|-----------|----------------|-----|
| 1 | Echo provider reports contextWindowTokens:4096, but default responseReserveTokens is also 4096 → maxPromptTokens=1, so ANY system prompt trips ensureSafeBudget() before a turn is added | 6 subagent tests | Raise echo's reported context window to 32768 (start; raise if needed) |
| 2 | Beacon AgentSession has no `status` field (type + DB schema) | 3 tests (agent-registers, agent-cleanup, full-agent-lifecycle) | Add `status` to beacon AgentSession type + schema + DB layer |
| 3 | Only dummy-agent registers → inter-agent needs 2 agents | 2 tests | Register a second agent in the test (or via a second dummy-agent container) |
| 4 | no-return-tool-call expects an error, but decision 115 made implicit-return the norm | 1 test | DROP the test (confirmed with user) |

## Steps
### Step 1 — Fix echo context window (root cause 1)
File: drone-agent/src/plugins/echo/index.ts
Change hardcoded contextWindowTokens:4096 in getContextWindowInfo() to 32768 (matching config default). If subagent tests still trip budget, raise further (65536, 131072) — user confirmed frontier models justify pushing high.
Test: add drone-agent/test/echo.test.ts registering echo plugin against mock DronePluginRegistration (mirror subagent-plugin.test.ts createMockRegistration pattern), capture provider via llm capability registerProvider, assert getContextWindowInfo() returns contextWindowTokens >= 32768.
Dependency: none. Agent: coder.

### Step 2 — Add `status` to beacon AgentSession (root cause 2)
Test fixture Agent type requires status:'connected'|'disconnected'|'busy'|'idle', but beacon AgentSession (type+DB) has no status. Beacon is source of truth for /agents.
Files:
- drone-beacon/src/types.ts — add status:'connected'|'disconnected'|'busy'|'idle' to AgentSession
- drone-beacon/src/db/init.ts — add status TEXT NOT NULL DEFAULT 'connected' to agent_sessions CREATE TABLE
- drone-beacon/src/db/agents.ts — set status:'connected' in registerAgent() returned session; include in INSERT; add status param to updateAgentActivity/unregisterAgent if needed (default 'connected')
Tests:
- drone-beacon/test/db.test.ts — extend "Beacon Agent Session CRUD": assert registerAgent returns status==='connected', listAgents/getAgent include status
- drone-beacon/test/routes.test.ts — extend "Agent Routes": assert POST /agents body has status==='connected', GET /agents entries have status
Dependency: none. Agent: coder.

### Step 3 — Register a second agent for inter-agent tests (root cause 3)
inter-agent.test.ts needs >=2 agents but only dummy-agent registers.
Option A (recommended): in inter-agent.test.ts beforeAll, after waiting for dummy-agent, POST a second agent directly to beacon via new fixture helper registerBeaconAgent(BEACON_URL, {id:'test-agent-2', personaId:null}). Self-contained, no new container.
Option B: add second dummy-agent service to docker-compose.integration-test.yaml with distinct AGENT_ID. Heavier.
Test: existing send-message-to-agent and message-delivery-status tests will pass (already assert agents.length>=2). Add registerBeaconAgent fixture helper in drone-agent/test/fixtures/swarm.ts + unit test if feasible.
Dependency: none. Agent: coder.

### Step 4 — Drop stale no-return-tool-call test (root cause 4)
File: drone-agent/test/subagent/dispatch.test.ts
Remove no-return-tool-call describe/it block (~lines 340-350). Implicit-return fallback (decision 115) is intentional.
Dependency: none. Agent: coder.

### Step 5 — Verify full suite
Run: pnpm test:integration (confirm 0 failures, 12 resolved/removed, 4 it.skipIf(usingEchoLlm) timeout/crash tests remain skipped)
Also: pnpm typecheck, pnpm -r run lint, pnpm -r run build, pnpm -r run test
Dependency: Steps 1-4. Agent: tester.

## Validation criteria
- pnpm test:integration passes with 0 failures (all 12 previously-failing tests now pass or removed; 4 it.skipIf(usingEchoLlm) timeout/crash tests remain skipped)
- pnpm typecheck passes (LSP + tsc clean across all packages)
- pnpm -r run lint passes (eslint + prettier)
- pnpm -r run build passes
- pnpm -r run test (fast suite) passes — including new echo.test.ts and extended beacon DB/route tests
- No dead code or unused variables; new code covered by unit tests

## User decisions
- Q1 (no-return-tool-call): DROP the test, do NOT restore old error behavior.
- Q2 (echo context window): start at 32768, raise as high as needed (frontier models justify 1M contexts).
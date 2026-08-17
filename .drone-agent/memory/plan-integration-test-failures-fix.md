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
updated: 2026-08-17T02:57:54.030Z
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

## COMPLETED (2026-08-17) — All steps implemented and verified
All 4 root causes fixed; integration suite now passes 0 failures.

### Step 1 (echo context window)
- drone-agent/src/plugins/echo/index.ts: getContextWindowInfo() contextWindowTokens 4096 → 32768.
- Added drone-agent/test/echo.test.ts (2 tests): registers echo provider via llm capability, asserts contextWindowTokens >= 32768. NOTE: the mock must capture the provider via a mutable holder object (getRegisteredProvider()), NOT destructured let — destructuring captures the initial undefined value.

### Step 2 (beacon status)
- drone-beacon/src/types.ts: AgentSession gains status:'connected'|'disconnected'|'busy'|'idle'.
- drone-beacon/src/db/init.ts: agent_sessions CREATE TABLE gains status TEXT NOT NULL DEFAULT 'connected'; PLUS idempotent migration (PRAGMA table_info check + ALTER TABLE ADD COLUMN) mirroring the existing lastExamined migration — CRITICAL because the beacon-data volume persists between `pnpm test:integration` runs (compose up without -v), so CREATE TABLE IF NOT EXISTS alone would NOT add the column to an existing table, causing "table agent_sessions has no column named status" 500s.
- drone-beacon/src/db/agents.ts: registerAgent() sets status:'connected' and includes it in the INSERT.
- Tests: db.test.ts "Beacon Agent Session CRUD" asserts status on register/get/list; added a migration test that creates a legacy agent_sessions table (no status column) then verifies initDatabase adds it and registerAgent succeeds. routes.test.ts "Agent Routes" asserts POST /agents and GET /agents return status:'connected'.

### Step 3 (second agent)
- drone-agent/test/fixtures/swarm.ts: added registerBeaconAgent(beaconUrl, agentId, personaId=null) helper (POST /agents).
- drone-agent/test/inter-agent.test.ts: beforeAll registers 'test-agent-2' after waiting for the dummy-agent, so send-message-to-agent and message-delivery-status have a recipient.

### Step 4 (drop stale test)
- drone-agent/test/subagent/dispatch.test.ts: removed the no-return-tool-call describe/it block. Also removed the now-unused launchTimeoutSubagent import (pre-existing dead import).

### Step 5 (verification)
- pnpm test:integration: 8 files passed, 65 passed | 4 skipped (timeout/crash subagent tests), 0 failures. All 12 previously-failing tests now pass.
- pnpm typecheck: pass. pnpm -r run build: pass. pnpm lint: pass. pnpm test: 1916 passed | 9 skipped.
- NOTE: `pnpm -r run lint` and `pnpm -r run test` are NOT valid commands — packages lack a lint script and drone-core has no test files. Use root `pnpm lint` and `pnpm test` instead.

### Additional notes
- The `pnpm lint` run (prettier --write) reformatted several files (docker/dummy-agent/src/index.ts, drone-agent/test/fixtures/assertions.ts, .drone-agent/*.md/json). These are legitimate formatting changes and were committed together.
- The echo plugin's `reasoningLevel` unused-variable hint in chat() is pre-existing (not introduced by this work).
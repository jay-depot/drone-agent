---
key: pre-existing-integration-failures
tags:
  - pre-existing
  - ui
  - tests
created: 2026-08-29T23:24:56.646Z
updated: 2026-09-04T04:20:48.210Z
---

# Integration failures

## OPEN (pre-existing, blocks coordinator-ui tests from RUNNING)

1. **drone-coordinator-ui vitest suite is pre-existing-broken** (2026-09-04): every `@testing-library/react` `render()` throws `TypeError: React.act is not a function` under react-dom 19.2.7 + @testing-library/react 16.3.2 (`node_modules/@testing-library/react/dist/act-compat.js` resolves `DeprecatedReactTestUtils.act` but react-dom/test-utils was removed/moved in 19.2.7). Affects ALL pages/*.test.tsx (wiki, wiki-tag, trust, etc.) — collision with UNMODIFIED tests confirmed by running wiki.test.tsx with the new sessions.test.tsx moved out. UI tests are NOT in root `vitest run` include glob (which covers drone-core/drone-agent/drone-beacon/drone-coordinator/drone-swarm-common/drone-swarm/drone-gateway), so they run only via `drone-coordinator-ui`'s own `pnpm test`, and they CANNOT pass in this env until the react/testing-library dep mismatch is resolved.

## RESOLVED 2026-08-29 (commit 7eda0f0, PR #85)

2. **coordinator-sync GET 401s (3 tests)** — FIXED: read via beacon coordinator proxy (`/coordinator/personas|skills`).
3. **e2e-swarm full-agent-lifecycle staleness (1 test)** — FIXED: test asserts against its own registered agent.

## Still-open upstream root cause (NOT fixed)

Spawned agents are never cleaned out of `agent_sessions` (zombie 'connected' rows) because they crash without an LLM provider — see memory `spawned-agent-llm-wiring`.

---
key: pre-existing-integration-failures
tags:
  - pre-existing
  - ui
  - tests
  - react-act
created: 2026-08-29T23:24:56.646Z
updated: 2026-09-04T04:33:18.296Z
---

# Integration failures

## RESOLVED 2026-09-04 — coordinator-ui vitest "React.act is not a function" was a RUN-ENV artifact, not a real break

Symptom: running `pnpm vitest run` (or `pnpm vitest run <file>`) directly in `drone-coordinator-ui` made EVERY @testing-library/react `render()` throw `TypeError: React.act is not a function` (from `react-dom/cjs/react-dom-test-utils.production.js`, a deprecated shim that calls `React.act`).

Root cause: react 19.2.7 only exports `.act` on its DEVELOPMENT build (`react.development.js` line ~806); the PRODUCTION build (`react.production.js`) has no `act`. `react/index.js` picks the build by `NODE_ENV`. When `NODE_ENV` is unset (direct `pnpm vitest run`, since vitest doesn't force it), react resolves to the production build → `React.act` is undefined → the react-dom-test-utils shim throws. @testing-library/react's `act-compat.js` sees `React.act === undefined` and falls back to the deprecated `DeprecatedReactTestUtils.act`, which internally calls `React.act` and blows up.

Fix: run the coordinator-ui tests via the package's `pnpm test` script, which sets `NODE_ENV=test` (`"test": "NODE_ENV=test vitest run"`). Under `NODE_ENV=test`, react loads the development build and `React.act` is a function. Verdict: the whole suite was never broken — all 12 files / 52 tests pass via `pnpm test`.

LESSON: when a project's test script sets `NODE_ENV`, reproduce via that exact script, not a bare `vitest run`. Root vitest (fast suite) excludes drone-coordinator-ui entirely; the UI suite is run standalone.

## RESOLVED 2026-08-29 (commit 7eda0f0, PR #85)

2. **coordinator-sync GET 401s (3 tests)** — FIXED: read via beacon coordinator proxy (`/coordinator/personas|skills`).
3. **e2e-swarm full-agent-lifecycle staleness (1 test)** — FIXED: test asserts against its own registered agent.

## Still-open upstream root cause (NOT fixed)
Spawned agents are never cleaned out of `agent_sessions` (zombie 'connected' rows) because they crash without an LLM provider — see memory `spawned-agent-llm-wiring`.
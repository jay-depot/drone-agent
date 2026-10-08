---
tags: [decision, testing, infrastructure]
related:
  [
    modules/drone-beacon.md,
    modules/drone-coordinator.md,
    concepts/test-infrastructure.md,
  ]
---

# ADR 041: Beacon & Coordinator Test Suite

**Status**: Implemented

**Date**: 2026-07-05

## Context

The `drone-beacon` and `drone-coordinator` packages are the backbone of multi-agent swarm coordination. Despite their critical role, they had minimal to no test coverage:

- **Coordinator**: 1 test file (`knowledge.test.ts`) covering knowledge CRUD — ~13 tests
- **Beacon**: Zero tests

This left the swarm infrastructure vulnerable to regressions as the roadmap progressed (Phase 4+).

## Decision

Add comprehensive test suites for both packages following the existing monorepo patterns (vitest, temp directory isolation, direct DB function testing, and route-level testing via Fastify's `app.inject()`).

### Test Architecture

**Database layer tests** — Direct function calls against a fresh temp SQLite database per test:

- `drone-coordinator/test/db.test.ts` — 76 tests: Persona, Skill, Beacon, BeaconTrust, BeaconSession, SwarmSession, SwarmEvent, AgentLocation, Insight, Principle CRUD
- `drone-beacon/test/db.test.ts` — 60 tests: Persona, Skill, AgentSession, Memory, Message, Spawn, Config, EventLog, KnowledgeCache, Insight, Principle CRUD

**Storage layer tests** — Blob storage engine:

- `drone-coordinator/test/storage.test.ts` — 11 tests: init, large payload detection, store/retrieve, edge cases

**Route tests** — Fastify `app.inject()` against a minimal app instance:

- `drone-coordinator/test/routes.test.ts` — 118 tests covering all route files (health, personas, skills, beacons, knowledge, swarm, messages, insights, principles) including knowledge route-ordering, swarm large payload, session pipeline 409 transitions, and detailed message relay/broadcast with fetch stubbing
- `drone-beacon/test/routes.test.ts` — 80 tests covering all route files (health, personas, skills, agents, memory, messages, spawn, config, events, insights, principles, sync)

**Auth middleware tests** — Unit tests for `isLocalRequest` and `createWebAuthMiddleware`:

- `drone-coordinator/test/auth.test.ts` — 11 tests

**Identity tests** — Ed25519 keypair management:

- `drone-beacon/test/identity.test.ts` — 7 tests

**TLS tests** — Certificate management (openssl-dependent):

- `drone-beacon/test/tls.test.ts` — 4 tests
- `drone-coordinator/test/tls.test.ts` — 4 tests

**Wiki storage tests** — Filesystem operations:

- `drone-beacon/test/wiki-storage.test.ts` — 12 tests
- `drone-coordinator/test/wiki-storage.test.ts` — 12 tests

**WebSocket server tests** — IP validation and connection management:

- `drone-beacon/test/ws-server.test.ts` — 11 tests

**Coordinator client tests** — HTTP client with mocked `http.request`:

- `drone-beacon/test/coordinator-client.test.ts` — 14 tests

### Key Design Decisions

1. **Test app helpers**: Both packages' `index.ts` have top-level imports of TLS, spawner, and WebSocket modules that don't resolve in the test environment. Created `app-helper.ts` files that build a minimal Fastify instance with just route registrations.

2. **Mocking**: Beacon route tests mock `spawner.js` and `ws-server.js` to avoid needing those subsystems initialized.

3. **Wiki route limitation**: Coordinator wiki routes use dynamic `import('drone-swarm-common/wiki-storage')` which goes through vitest's alias resolution. The alias doesn't work for dynamic imports from test files, so wiki route tests were deferred. Wiki storage is tested separately in `wiki-storage.test.ts`.

4. **Shared harness**: Created `drone-coordinator/test/helpers/server.ts` with `makeApp()`/`teardownApp()` that sets up DB+storage+wiki in one call, though it can't use `buildApp()` from `index.ts` due to the TLS import issue.

5. **Fetch stubbing**: Message relay/broadcast tests use `vi.stubGlobal('fetch', ...)` to stub outbound HTTP calls, asserting only on observable behavior (status codes, response bodies) — not on `fetch` call internals — so tests survive the planned `fetch` removal refactor.

### Bug Fixes Discovered

- **`drone-coordinator/src/db.ts`**: Fixed `approveBeacon()` — was querying by `approval_token` after setting it to NULL; now finds `beacon_id` first, then queries by `beacon_id`
- **`drone-coordinator/src/db.ts`**: Fixed FTS5 search query — wrong column reference (`fts.id` → `fts.rowid`)

### TypeScript Cleanup

Fixed 13 pre-existing typecheck errors across 7 test files:

- **`execute` on `DroneToolDescriptor`** (6 errors): `DroneToolDescriptor` (used by LLM provider `chat()`) doesn't have `execute` — that's on `DroneToolDefinition` (used by the plugin engine). Removed unnecessary `execute` from tool objects in `anthropic.test.ts`, `openai.test.ts`, `openrouter.test.ts`.
- **Tuple type on `mock.calls[0]`** (4 errors): Added `as unknown` cast before tuple type assertions in `anthropic.test.ts`, `first-run.test.ts`, `openai.test.ts`.
- **Missing `openai`/`anthropic` config fields** (3 errors): `DroneAgentConfig` requires these fields. Added minimal stubs in `log-plugin.test.ts`, `prompt-file.test.ts`, `terminal.test.ts`.

## Consequences

**Positive**:

- 1125 tests pass across 57 test files (0 failures)
- `pnpm typecheck` is clean across all 6 workspace packages
- `pnpm lint` passes cleanly
- Every route file in both packages has at least happy-path + primary error-path coverage
- Regression protection for the swarm infrastructure
- Faster iteration — changes can be validated without manual server restarts

**Negative**:

- Wiki route tests couldn't be included due to vitest alias limitations with dynamic imports
- The shared harness (`helpers/server.ts`) can't use `buildApp()` from `index.ts` due to TLS import issues, so route tests use a separate `app-helper.ts`

## Related

- [drone-beacon](../../drone-beacon/) — Beacon module with route tests
- [drone-coordinator](../../drone-coordinator/) — Coordinator module with route tests
- test-infrastructure — Test patterns and infrastructure

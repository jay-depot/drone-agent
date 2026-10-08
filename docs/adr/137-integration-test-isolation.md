---
tags: [decision, testing, integration, swarm]
related:
  [
    concepts/test-infrastructure.md,
    concepts/subagent.md,
    modules/drone-beacon.md,
    modules/drone-coordinator.md,
  ]
---

# 137: Isolated Integration Testing for Beacon Interactions

**Status**: Implemented (2026-08-17)

## Context

Swarm integration tests (agent ↔ beacon ↔ coordinator interactions) previously relied on ad-hoc Docker setups and could accidentally connect to a user's real local beacon/coordinator when run outside the provisioned environment. The old test-runner Dockerfile used a minimal `node:22-alpine` image that couldn't build native modules required by the workspace dependencies.

Additionally, several integration test helpers were incomplete or stale:

- The beacon's channel subscription API had no REST fallback (only WebSocket)
- Message body payloads weren't consistently JSON-stringified
- Coordinator API paths in test helpers didn't match the `/api` prefix

## Decision

### 1. Isolated Docker swarm provisioning

`pnpm test:integration` now runs the real Vitest integration suite inside an isolated Docker network:

- `docker/docker-compose.integration-test.yaml` — provisions echo-llm, drone-coordinator, drone-beacon, dummy-agent, and test-runner containers on a private `test-swarm` network. All host port mappings removed — no exposure to the host loopback.
- `docker/test-runner.Dockerfile` — upgraded from `node:22-alpine` to `node:22-slim` with build tooling (python3, make, g++) for native modules. Copies workspace packages, runs `pnpm install --frozen-lockfile` + `pnpm build`, sets `ENV PATH` for the subagent fixture, and configures the echo LLM provider.
- `.github/workflows/integration-test.yml` — now runs `pnpm test:integration` directly (no manual docker compose steps).

### 2. Provisioning guards

`drone-agent/test/fixtures/swarm.ts` adds `shouldSkipIntegrationSuite()` and `getRequiredIntegrationEnv()`:

- Suites refuse to run unless `RUN_INTEGRATION_TESTS=true`
- Suites skip (via `describe.skipIf`) when a target resolves to its unsafe `localhost` fallback (env not provided)
- The subagent dispatch test file gained the same guards

### 3. REST channel subscription routes

New `drone-beacon/src/routes/channels.ts`:

- `PUT /agents/:agentId/channels/:channel` — subscribe an agent to a channel via REST (works for non-WS agents)
- `DELETE /agents/:agentId/channels/:channel` — unsubscribe
- `POST /channels/:channel/messages` — send a channel message (verifies sender registration)
- `GET /channels/:channel/messages` — list channel messages

Added `restSubscribeToChannel()` / `restUnsubscribeFromChannel()` wrappers to `ws-server.ts`.

### 4. Agent session status migration

`agent_sessions` table gains a `status` column (`'connected' | 'disconnected' | 'busy' | 'idle'`), with an idempotent migration (`PRAGMA table_info` + `ALTER TABLE` if missing).

### 5. Test helper fixes

- `getBeaconMessages` uses `/messages?agentId=...` (not `/agents/:id/messages`)
- `sendBeaconMessage`/`sendChannelMessage` use `fromAgentId`/`toAgentId` and JSON-stringify bodies
- Coordinator API paths in test helpers use the `/api` prefix
- `registerBeaconAgent` — direct REST registration fallback for tests
- `echo` plugin's context window bumped from 4096 to 32768 (safety-trim budget no longer trips on system prompt alone)

## Consequences

### Positive

- Integration tests are fully isolated — they can never touch a user's real local beacon/coordinator
- `pnpm test:integration` is a one-command Docker flow
- Native module builds work in the test runner (node:22-slim + build tooling)
- Channel subscriptions work via REST for non-WS agents
- Session status is persisted and queryable

### Negative

- Integration tests require Docker; not runnable directly on the host (by design)
- `node:22-slim` base image is larger than the old `node:22-alpine`

## Files Modified

| File                                          | Changes                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `docker/docker-compose.integration-test.yaml` | Private test-swarm network, no host port mappings                                              |
| `docker/test-runner.Dockerfile`               | node:22-slim, build tooling, pnpm workspace install                                            |
| `docker/dummy-agent/src/index.ts`             | Registration retry loop (10 attempts, 2s delay)                                                |
| `.github/workflows/integration-test.yml`      | `pnpm test:integration` direct                                                                 |
| `drone-agent/test/fixtures/swarm.ts`          | `shouldSkipIntegrationSuite`, `getRequiredIntegrationEnv`, `registerBeaconAgent`, helper fixes |
| `drone-agent/test/subagent/dispatch.test.ts`  | Integration guards                                                                             |
| `drone-beacon/src/routes/channels.ts`         | **New** — REST channel subscription routes                                                     |
| `drone-beacon/src/ws-server.ts`               | REST wrappers for channel subscribe/unsubscribe                                                |
| `drone-beacon/src/routes/index.ts`            | Register channel routes                                                                        |
| `drone-beacon/src/db/init.ts`                 | `status` column migration on agent_sessions                                                    |
| `drone-beacon/src/types.ts`                   | `AgentSession.status` field                                                                    |
| `drone-agent/src/plugins/echo/index.ts`       | Context window 4096 → 32768                                                                    |

## Related

- test-infrastructure — Test patterns and infrastructure
- subagent — Subagent dispatch (the test fixture that needed the guards)
- [drone-beacon](../../drone-beacon/) — Beacon module (channels routes, session status)
- [drone-coordinator](../../drone-coordinator/) — Coordinator module

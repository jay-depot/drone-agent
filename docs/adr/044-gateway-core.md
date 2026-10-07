---
tags: [decision, gateway, architecture]
related: [modules/drone-gateway.md, concepts/spawn-backend.md, concepts/json-listen-mode.md, modules/drone-swarm-common.md, decisions/235-gateway-architecture-standalone-service.md]
---

# 044: Gateway Core — Standalone Service + Pluggable Spawn Backends

**Status**: Implemented (2026-07-06)

## Context

The drone swarm needed a way to connect chat platforms (Matrix, Telegram, Slack) to the swarm. Rather than building platform-specific integrations into the agent itself, we created a standalone `drone-gateway` service that acts as the bridge between human conversation and agent coordination.

## Decision

### 1. Standalone Mode

The gateway works without a beacon or coordinator. The `persona-assignment` control surface spawns `drone-agent` locally on the host using the `LocalSpawnBackend`.

### 2. Persistent Sessions

The gateway maintains long-lived agent processes per conversation (not spawn-per-message). The agent stays alive, maintaining in-memory LLM context across turns. This is critical for natural conversation flow — each message doesn't start from scratch.

### 3. `--output-json` as the Protocol

No new `--listen` flag was needed. The existing `--output-json` mode reads NDJSON from stdin and writes NDJSON to stdout. Without `--once`, it loops — reading `chat` events from stdin and writing NDJSON events (including a new `turnComplete` event) to stdout.

### 4. `turnComplete` Event

A new NDJSON event type emitted by the agent after finishing each turn, so the gateway knows when the agent is ready for the next message.

### 5. Shared Spawner

The spawn logic from `drone-beacon/src/spawner.ts` was extracted into `drone-swarm-common` so both beacon and gateway can use the same code. The shared spawner is database-agnostic via a `SpawnDb` interface.

### 6. Pluggable Spawn Backend

The gateway has a `SpawnBackend` interface with two implementations:
- `LocalSpawnBackend` — spawns `drone-agent` processes on the host (standalone mode)
- `CoordinatorSpawnBackend` — delegates to the coordinator's web port (swarm mode)

### 7. Agent Binary Path

Config field first (`agentPath`), fall back to `$PATH` lookup via a `which()` utility.

## Consequences

- **Positive**: Gateway can run standalone without any swarm infrastructure
- **Positive**: Service adapters (Matrix, Telegram, Slack) are deferred to follow-up phases — the architecture is ready for them
- **Positive**: The shared spawner eliminates duplication between beacon and gateway
- **Positive**: The `turnComplete` event makes the NDJSON protocol suitable for multi-turn conversations
- **Positive**: 59 tests across 6 test files covering all core components (which, coordinator-client, local-spawn-backend, coordinator-spawn-backend, engine, index)
- **Positive**: Architecture decision record (ADR 001) documented in the gateway's own docs directory covering 5 key decisions
- **Tradeoff**: The coordinator spawn backend is a simplified implementation — full persistent session support requires the coordinator's messaging system to be fully operational
- **Tradeoff**: Service adapter implementations are not yet built — the engine throws if any adapter type is configured

## Related

- [[modules/drone-gateway]] — The gateway package
- [[concepts/spawn-backend]] — Pluggable spawn backend architecture
- [[concepts/json-listen-mode]] — JSON listen mode for persistent agent sessions
- [[modules/drone-swarm-common]] — Shared spawner in drone-swarm-common
- [[decisions/027-drone-swarm-common]] — Original drone-swarm-common extraction
- [[decisions/235-gateway-architecture-standalone-service]] — Gateway architecture ADR (in drone-gateway/docs/adr/)

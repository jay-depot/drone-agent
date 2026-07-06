---
key: gateway-core-plan
tags: []
created: 2026-07-06T02:31:56.640Z
updated: 2026-07-06T03:07:51.665Z
---

# Phase 4: drone-gateway — Expanded Plan (Standalone + Swarm Modes)

## Summary

Create the `drone-gateway` package — a standalone service that connects chat platforms to the drone swarm. This plan covers the core gateway loop, service adapter interface, control surface interface, coordinator client, config format, **standalone mode** (no beacon/coordinator required), **persistent agent sessions**, and the **pluggable spawn backend** architecture. Service adapter implementations (Matrix, Telegram, Slack) and specific control surfaces (swarm-console, mention-router) are deferred to follow-up plans.

## Key Decisions

1. **Standalone mode**: Gateway works without beacon or coordinator. `persona-assignment` control surface spawns `drone-agent` locally on the host.
2. **Persistent sessions**: The gateway maintains long-lived agent processes per conversation (not spawn-per-message). The agent stays alive, maintaining in-memory LLM context across turns.
3. **`--output-json` as the protocol**: No new `--listen` flag needed. The existing `--output-json` mode reads NDJSON from stdin and writes NDJSON to stdout. Without `--once`, it loops — reading `chat` events from stdin and writing NDJSON events (including a new `turnComplete` event) to stdout.
4. **`turnComplete` event**: A new NDJSON event type emitted by the agent after finishing each turn, so the gateway knows when the agent is ready for the next message.
5. **Shared spawner**: Extract the spawn logic from `drone-beacon/src/spawner.ts` into `drone-swarm-common` so both beacon and gateway can use the same code.
6. **Pluggable spawn backend**: Gateway has a `SpawnBackend` interface with `LocalSpawnBackend` (standalone) and `CoordinatorSpawnBackend` (swarm mode).
7. **Agent binary path**: Config field first (`agentPath`), fall back to `$PATH` lookup.

## Domain Language

- **Gateway** — the standalone service itself
- **Service Adapter** — a platform integration (Matrix, Telegram, Slack). Each adapter knows how to connect to that platform's API, authenticate, and translate between platform-specific message formats and the gateway's internal format.
- **Control Surface** — a configuration that maps a chat conversation (room, DM, channel) to a behavior. A control surface is attached to a service adapter.
- **Persona Assignment** — a control surface that routes all messages in a conversation to a specific persona
- **Swarm Console** — a control surface that exposes coordinator commands (spawn, status, terminate, list beacons, etc.)
- **Mention Router** — a control surface that watches for `!persona` mentions and routes those messages to the specified persona
- **Spawn Backend** — a pluggable strategy for spawning and managing agent processes. Two implementations: `LocalSpawnBackend` (spawns processes on the host) and `CoordinatorSpawnBackend` (delegates to the coordinator's web port).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   drone-gateway                      │
│                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ Matrix       │  │ Telegram    │  │ Slack       │  │
│  │ Adapter      │  │ Adapter     │  │ Adapter     │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │
│         │                │                │          │
│         ▼                ▼                ▼          │
│  ┌─────────────────────────────────────────────────┐ │
│  │              Gateway Engine                     │ │
│  │  (routes messages → control surfaces → send)   │ │
│  └──────────────────────┬──────────────────────────┘ │
│                         │                             │
│  ┌──────────────────────┴──────────────────────────┐ │
│  │           Spawn Backend (pluggable)             │ │
│  │  ┌────────────────┐  ┌──────────────────────┐  │ │
│  │  │ LocalSpawn     │  │ CoordinatorSpawn     │  │ │
│  │  │ Backend        │  │ Backend              │  │ │
│  │  │ (spawns agent  │  │ (delegates to        │  │ │
│  │  │  processes)    │  │  coordinator:8080)   │  │ │
│  │  └────────────────┘  └──────────────────────┘  │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

## Files to Create/Modify

### Package Scaffold (already created)

| File                                      | Purpose                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| `drone-gateway/package.json`              | ESM package, depends on drone-core, pino                 |
| `drone-gateway/tsconfig.json`             | TypeScript config, references drone-core                 |
| `drone-gateway/bin/drone-gateway`         | CLI entry point (shebang)                                |
| `drone-gateway/src/index.ts`              | Main entry, CLI arg parsing, startup                     |
| `drone-gateway/src/types.ts`              | DroneServiceAdapter, DroneControlSurface, config types   |
| `drone-gateway/src/engine.ts`             | Gateway engine: load config, init adapters, message loop |
| `drone-gateway/src/coordinator-client.ts` | HTTP client for coordinator web port                     |
| `drone-gateway/src/logger.ts`             | Pino logger                                              |
| `drone-gateway/CONTEXT.md`                | Domain glossary                                          |
| `drone-gateway/docs/adr/`                 | Empty directory for future ADRs                          |

### 1. drone-swarm-common: Extract spawner

**New file:** `drone-swarm-common/src/spawner.ts`

- Extract the core spawn logic from `drone-beacon/src/spawner.ts` (process spawning, tracking, termination, cleanup)
- Make it database-agnostic (no dependency on beacon's db.ts)
- Export: `SpawnerConfig`, `ManagedProcess`, `initSpawner`, `spawnAgent`, `terminateAgent`, `getActiveSpawns`, `cleanupAllSpawns`

**Modified:** `drone-swarm-common/package.json` — add `"./spawner"` export entry
**Modified:** `drone-swarm-common/src/index.ts` — re-export spawner types
**Modified:** `drone-beacon/src/spawner.ts` — delegate to `drone-swarm-common/spawner` (thin wrapper)

### 2. drone-agent: Add `turnComplete` event + persistent JSON mode

**Modified:** `drone-agent/src/output-handlers.ts`

- Add `turnComplete` to the `OutputEvent` union type

**Modified:** `drone-agent/src/interactive.ts`

- Add a `runJsonListenMode()` function that loops:
  1. Read a `chat` event from stdin
  2. Process it via `conversation.sendUserMessage()`
  3. Write NDJSON events to stdout
  4. Write a `turnComplete` event to stdout
  5. Loop back to step 1
- The `InputEvent` type gets a `chat` variant (already exists)

**Modified:** `drone-agent/src/index.tsx`

- When `--output-json` is set WITHOUT `--once`, call `runJsonListenMode()` instead of `runJsonMode()`

### 3. drone-gateway: Spawn backend interface + local implementation

**Modified:** `drone-gateway/src/types.ts`

- Add `SpawnBackend` interface
- Add `SpawnBackendType` union: `"local" | "coordinator"`
- Add `agentPath` to `GatewayConfig`
- Add `SpawnSession` type (tracks persistent agent process per conversation)

**New file:** `drone-gateway/src/spawn-backend.ts`

- `SpawnBackend` interface:
  ```typescript
  interface SpawnBackend {
    type: SpawnBackendType;
    spawnSession(
      conversationId: string,
      personaId: string
    ): Promise<SpawnSession>;
    sendMessage(session: SpawnSession, message: string): Promise<string>;
    terminateSession(session: SpawnSession): Promise<void>;
  }
  ```

**New file:** `drone-gateway/src/local-spawn-backend.ts`

- `LocalSpawnBackend` class implementing `SpawnBackend`
- Uses the shared spawner from `drone-swarm-common/spawner`
- Manages persistent agent processes: one per conversation
- Sends NDJSON `chat` events to agent's stdin
- Reads NDJSON events from agent's stdout
- Waits for `turnComplete` event before sending next message
- Handles agent crash/recovery

**New file:** `drone-gateway/src/coordinator-spawn-backend.ts`

- `CoordinatorSpawnBackend` class implementing `SpawnBackend`
- Delegates to the existing `CoordinatorClient`
- For persistent sessions, uses coordinator's session tracking

### 4. drone-gateway: Update engine for spawn backends

**Modified:** `drone-gateway/src/engine.ts`

- Accept a `SpawnBackend` in constructor
- `persona-assignment` control surface uses the spawn backend
- Config determines which backend to use (local vs coordinator)

### 5. drone-gateway: Update config and entry point

**Modified:** `drone-gateway/src/types.ts` — add spawn backend config
**Modified:** `drone-gateway/src/index.ts` — instantiate the appropriate spawn backend based on config

## Config File (example)

```json
{
  "coordinatorUrl": "http://localhost:8080",
  "coordinatorToken": "<web-token>",
  "spawnBackend": "local",
  "agentPath": "/usr/local/bin/drone-agent",
  "serviceAdapters": [
    {
      "id": "my-matrix",
      "type": "matrix",
      "config": {
        "homeserver": "https://matrix.example.com",
        "userId": "@drone-bot:example.com",
        "accessToken": "..."
      },
      "controlSurfaces": [
        {
          "type": "persona-assignment",
          "conversationId": "!dev-room:example.com",
          "personaId": "coder"
        },
        {
          "type": "swarm-console",
          "conversationId": "!swarm-admin:example.com"
        },
        {
          "type": "mention-router",
          "conversationId": "!general:example.com"
        }
      ]
    }
  ]
}
```

## Validation Criteria

1. **LSP checks pass** — No TypeScript errors across all packages
2. **`pnpm build` passes** — All packages compile
3. **`pnpm test` passes** — All existing tests continue to pass (1151 tests)
4. **`pnpm lint` passes** — ESLint + Prettier checks pass
5. **Manual verification**:
   - `drone-agent --output-json` without `--once` stays alive and processes multiple `chat` events
   - Gateway config with `spawnBackend: "local"` and `agentPath` works
   - Gateway config without `agentPath` falls back to `$PATH` lookup

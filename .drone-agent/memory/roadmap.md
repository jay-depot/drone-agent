---
key: roadmap
tags:
  - roadmap
created: 2026-06-24T01:49:32.293Z
updated: 2026-07-08T20:13:31.773Z
---

# Swarm Roadmap

## Project Vision

The `drone` agent platform aims to be "the Arch of AI agents": minimalist out of the box, flexible, and capable of becoming an intricate, customized and powerful, distributed system.

**Design Principles:**

- Minimalist core: Works with almost nothing enabled; plugins add functionality
- Model-centric: No hundreds of lines of system prompts; let the LLM figure it out with tools
- Project-first: Config cascades (Project > User > Beacon > Coordinator > System defaults)
- Self-dogfooding: The project should be developed using itself
- **Single-user swarm**: A swarm serves one human with multiple AI agents. Multi-user coordination is out of scope (use MCP servers for that).

---

## What is a Swarm?

A **swarm** is a personal AI workforce - multiple agents working in concert for a single human. Think of it as having a team of specialists where you're the manager.

**Use Cases:**

- One agent writes code while another reviews it
- One agent researches while another synthesizes
- Parallel exploration with result aggregation
- Background agents that watch/act while you focus elsewhere
- Complex, autonomous workflows coordinated across multiple agents with shared memory and skills

**Multi-user Note:** If you need multiple humans to coordinate through the swarm, use an MCP server designed for that (e.g., MCP Jam, CrewAI Cloud). The drone swarm is intentionally single-user.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   drone-gateway                     │
│  (Chat APIs: Matrix, Discord, Slack, relaying       │
│   messages into swarm, launching agents on demand)  │
│  *Single-user: messages routed to YOUR agents       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                 drone-coordinator                   │
│  (Personal control plane: web UI, task management,  │
│   your skills, personas, memory, identities)        │
│  *Single-user: manages YOUR agents only            │
│  *must* have a beacon on the same host              │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                  drone-beacon                       │
│  (Local coordination: YOUR system-wide skills,      │
│   memories, inter-agent communication)              │
│  *Single-user: serves YOUR agents on this host      │
│  runs on same host or on LAN                        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                   drone-agent                       │
│  (CLI/TUI: LLM, tools, MCP client, plugins)         │
│  *YOUR agent - works standalone or in swarm         │
│  runs anywhere, works standalone                    │
└─────────────────────────────────────────────────────┘
```

**Failure Mode: Graceful Degradation**

- **Offline:** Agent works with project/user config files. Beacon adds host-wide skills/memory.
- **LAN:** Your agents share via beacon on the same network.
- **Cloud/VPN:** Your agents coordinate via coordinator from anywhere.

**Key Insight:** All assets (personas, skills, memories) are **yours**. There's no permission system for multiple users because there's only one user.

---

## Self-Improvement System

The drone-agent swarm includes a **self-improving architecture** that enables continuous learning across all your agents:

### Components

| Layer           | Component                 | Self-Improvement Role                        |
| --------------- | ------------------------- | -------------------------------------------- |
| **Coordinator** | Global session storage    | Your agents' sessions searchable             |
| **Coordinator** | Knowledge registry        | Your skills, patterns, facts, preferences    |
| **Coordinator** | Swarm review task         | Identifies patterns across YOUR beacons      |
| **Coordinator** | Broadcast mechanism       | Propagates learned knowledge to your beacons |
| **Beacon**      | Local session storage     | Offline operation                            |
| **Beacon**      | Your local memory         | Your preferences                             |
| **Beacon**      | Push to coordinator       | Session data on session end                  |
| **Beacon**      | Sync knowledge            | Pull updates from coordinator                |
| **Agent**       | Background review fork    | Per-turn learning                            |
| **Agent**       | Skill creation/management | On-demand skill building                     |
| **Agent**       | Memory read/write         | Your local knowledge updates                 |

### Data Flow

```
Your Agent Turn Ends
    │
    ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Local Review │───▶│ Save Local   │───▶│ Update       │
│ (optional)   │     │ Session      │     │ Memory       │
└──────────────┘     └──────────────┘     └──────────────┘
         │                                   │
         │         ┌─────────────────────────┘
         │         ▼
         │  ┌────────────────────────┐
         │  │ Push to Coordinator    │
         │  │ (if enabled)           │
         │  └────────────────────────┘
         │         │
         ▼         ▼
┌─────────────────────────────────────────┐
│ COORDINATOR (YOUR swarm hub)            │
│ - Store Sessions                        │
│ - Index FTS (searchable)                │
│ - Swarm Review (identify patterns)      │
│ - Broadcast Knowledge                   │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ ALL YOUR BEACONS SYNC                   │
│ - Updated skills                        │
│ - Shared patterns                       │
│ - Aggregated preferences                │
└─────────────────────────────────────────┘
```

### Config Integration

```typescript
swarm: {
  enabled: boolean,
  coordinatorUrl: string,
  shareSessions: boolean,      // Push your sessions to coordinator
  shareMemory: boolean,       // Share your memory across YOUR agents
  shareSkills: boolean,         // Sync your skills across your beacons
  localNudgeInterval: number,      // default: 10 turns
  swarmReviewIntervalMinutes: number,
  searchableByDefault: boolean,
}
```

---

## Phase Roadmap

### ✅ PHASE 1: drone-agent (COMPLETE)

**Status:** Complete

The standalone coding agent - your AI assistant, whether solo or as part of your swarm.

**Delivered:**

- Ink-based TUI (full-screen interactive chat)
- Plain text output mode
- Plugin system with dynamic enabling
- Built-in plugins: skills, persona, memory, lsp, mcp, git, compact, bootstrap
- Config system with cascade (Project > User > Default)
- Session management (disposable workers)
- Persona management (persistent identities)
- Skills system (load from disk)
- Memory system (JSON files in .drone-agent/)
- MCP client integration
- LSP integration with auto-download
- Context budgeting and compaction
- Self-improvement/insights system
- **Swarm plugin** for connecting to beacon

**Key Files:**

- `drone-agent/src/index.tsx` - CLI entry point
- `drone-agent/src/runtime/plugin-engine.ts` - Plugin lifecycle
- `drone-agent/src/runtime/conversation-service.ts` - LLM loop
- `drone-agent/src/plugins/index.ts` - Built-in plugins
- `drone-agent/src/plugins/swarm/index.ts` - Swarm plugin (connects to beacon)
- `drone-core/src/index.ts` - Shared types

---

### ✅ PHASE 2: drone-beacon (COMPLETE)

**Status:** Complete

Local coordination layer for YOUR swarm on one machine.

**What's Built:**

- Fastify HTTP server (port 3457 by default)
- SQLite database (better-sqlite3) with tables for personas, skills, agent sessions, memory, events, wiki, insights, principles
- REST API endpoints for all CRUD operations
- WebSocket server for inter-agent messaging
- Agent spawn execution (`/spawn` endpoint with `spawner.ts`)
- Coordinator client for registering beacon and syncing assets
- TLS support with auto-generated certificates
- Ed25519 keypair identity management
- Event logging and config overrides

**Self-Improvement Integration:**

- Local session storage (for offline operation)
- Your local memory (your preferences)
- Push to coordinator on session end
- Sync knowledge from coordinator

**How It Works:**

1. Your agent enables `swarm` plugin
2. Plugin registers your agent session with beacon via POST `/agents`
3. Plugin fetches YOUR personas/skills from beacon (scope: local vs coordinator)
4. Heartbeat every 30 seconds to keep session alive
5. On shutdown, agent unregisters via DELETE `/agents/:id`

---

### ✅ PHASE 3: drone-coordinator (SUBSTANTIALLY COMPLETE)

**Status:** Substantially Complete — core infrastructure, security, session storage, knowledge management, wiki, insights/principles, migration tool, monitoring web UI, comprehensive test coverage, and inter-beacon spawn routing are all implemented. A few small items remain.

Personal control plane for YOUR swarm across machines.

#### 3.1 Secure Foundation ✅

- Ed25519 Keypair Management (`identity.ts`)
- TLS Certificate Generation (`tls.ts`) — auto-generates self-signed certs via openssl
- Beacon Approval Flow & Trust Tables
- Local-only WSS Enforcement
- HTTPS Server Configuration (Fastify TLS)

#### 3.2 Shared Session Storage ✅

- `swarm_sessions`, `swarm_events`, `agent_locations` tables with FTS5
- Session registration and event push from beacons
- Full-text search on event payloads
- Agent location tracking for cross-beacon routing

#### 3.3 Global Memory & Skills ✅

- `knowledge` table with CRUD + search + sync (push/pull)
- Confidence-based conflict resolution
- Beacon-side knowledge cache with periodic sync

#### 3.4 Swarm Knowledge Base (LLM Wiki) ✅

- Wiki pages stored as `.md` files on server filesystem with YAML frontmatter
- REST endpoints on both beacon and coordinator
- Beacon proxies coordinator-scoped requests
- Scope enforcement (no downward links)
- Agent tools: `wiki_read`, `wiki_write`, `wiki_search`, `wiki_list`, `wiki_delete`, `wiki_lint`

#### 3.5 Swarm-Wide Insights & Principles ✅

- Self-improvement plugin refactored to broker pattern with storage engine registration
- Beacon and coordinator each have insights and principles tables
- REST endpoints: CRUD for both, with `?scope=coordinator` proxy on beacon
- Swarm plugin registers HTTP storage engines for beacon/coordinator
- Combined principles prompt fragment reads from all relevant providers

#### 3.6 Migration Tool ✅

A CLI tool (`drone-migrate` or `drone-agent migrate`) for promoting/demoting assets between local and swarm scopes.

**Supported asset types:** persona, skill, insight, principle, wiki

**Operations:**

- Promote (local → swarm): project → user → beacon → coordinator
- Demote/pull (swarm → local): coordinator → beacon → user → project
- Batch migration of all assets of a type
- Backup before migration

**Key Files:**

- `drone-agent/bin/drone-migrate` — CLI binary
- `drone-agent/src/migrate.ts` — CLI entry point
- `drone-agent/src/runtime/migration/` — Migration logic (modular, ~12 files)
- `drone-agent/test/migration.test.ts` — Tests

#### ✅ 3.7 Web UI (Monitoring Dashboard)

**Status:** Complete

A monitoring dashboard web UI for the coordinator — React SPA with shadcn/ui, tweakcn themes, and WebSocket-based real-time updates. Served by the coordinator itself via `@fastify/static`.

**Pages (v1 — monitoring only):**

- **Swarm Topology** — beacons with online/offline status and active agent counts
- **Sessions** — list of open sessions with real-time peek into session event logs
- **Session Detail** — dedicated page showing all recent events with collapsible payloads
- **Personas** — read-only list
- **Skills** — read-only list
- **Wiki** — read-only list

**Architecture:**

- New `drone-coordinator-ui` package in the monorepo (Vite + React + shadcn/ui)
- Declared as `"drone-coordinator-ui": "workspace:*"` dependency of `drone-coordinator`
- Coordinator serves built static files and provides WebSocket endpoint at `/ws`
- In-memory pub/sub for pushing new swarm events to connected clients
- CORS enabled in development mode

**Key Files:**

- `drone-coordinator-ui/package.json` — Vite/React project config
- `drone-coordinator-ui/src/App.tsx` — Router + layout
- `drone-coordinator-ui/src/pages/topology.tsx` — Beacon topology view
- `drone-coordinator-ui/src/pages/sessions.tsx` — Session list
- `drone-coordinator-ui/src/pages/session-detail.tsx` — Session event log
- `drone-coordinator-ui/src/pages/personas.tsx` — Persona list
- `drone-coordinator-ui/src/pages/skills.tsx` — Skill list
- `drone-coordinator-ui/src/pages/wiki.tsx` — Wiki page list
- `drone-coordinator-ui/src/hooks/use-websocket.ts` — WebSocket connection hook

**Coordinator changes:**

- Add `@fastify/websocket`, `@fastify/static`, `@fastify/cors` dependencies
- Register WebSocket endpoint at `/ws` with per-session event subscription
- Serve UI static files and add SPA fallback handler

**Dependencies:** 3.2 (session storage), 3.4 (wiki)

#### ⏳ 3.8 Make `--https` Default

**Status:** Pending

Certificate auto-generation already exists on both beacon and coordinator. The change is to flip the default from `false` to `true`:

- Coordinator: `process.env.COORDINATOR_HTTPS === 'true'` → `process.env.COORDINATOR_HTTPS !== 'false'`
- Beacon: Same pattern for `BEACON_HTTPS` and `COORDINATOR_HTTPS`

**Note (verified 2026-07-07):** Both beacon (`drone-beacon/src/index.ts` lines 82-83) and coordinator (`drone-coordinator/src/index.ts` line 80) still use `=== 'true'` (opt-in, default off). This item remains unimplemented.

**Nice-to-have:** Add a pure Node.js certificate generation fallback (using `crypto`) for environments without `openssl` CLI.

#### ✅ 3.9 Inter-Beacon Spawn Routing

**Status:** Complete

The coordinator now has a full set of spawn relay routes that forward requests to target beacons, plus LLM-facing tools in the swarm plugin for remote agent lifecycle management.

**Coordinator routes** (in `drone-coordinator/src/routes/spawn.ts`):

| Route                              | Purpose                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `POST /spawn`                      | Spawn agent on target beacon (requires `targetBeaconId`) |
| `GET /spawn/:beaconId`             | List spawns on a beacon (optional `?status=` filter)     |
| `GET /spawn/:beaconId/:spawnId`    | Get spawn status                                         |
| `DELETE /spawn/:beaconId/:spawnId` | Terminate a spawned agent                                |

All routes follow the same pattern as the message relay: look up beacon via `db.getBeacon()` → 404 if not found → forward via `fetch()` → 502 on beacon error → 503 on network error.

**LLM tools** (in `drone-agent/src/plugins/swarm/index.ts`):

| Tool                    | Calls Coordinator                                   |
| ----------------------- | --------------------------------------------------- |
| `swarm_list_beacons`    | `GET /beacons`                                      |
| `swarm_list_agents`     | `GET /agents/location` (optional `beaconId` filter) |
| `swarm_spawn`           | `POST /spawn`                                       |
| `swarm_get_spawn`       | `GET /spawn/:beaconId/:spawnId`                     |
| `swarm_list_spawns`     | `GET /spawn/:beaconId` (optional `status` filter)   |
| `swarm_terminate_spawn` | `DELETE /spawn/:beaconId/:spawnId`                  |

**Config:** Added `coordinatorUrl` to both `SwarmConfig` (plugin) and `DroneSwarmConfig` (drone-core types). All tools return a clear error if not configured.

**Key Files:**

- `drone-coordinator/src/routes/spawn.ts` — All 4 spawn relay routes
- `drone-coordinator/src/types.ts` — `SpawnConfig` and `SpawnRequest` types
- `drone-agent/src/plugins/swarm/index.ts` — 6 spawn/info tools
- `drone-core/src/config-types.ts` — `coordinatorUrl` in `DroneSwarmConfig`
- `drone-coordinator/test/routes.test.ts` — 16 spawn route tests
- `drone-agent/test/swarm-spawn.test.ts` — 12 swarm plugin tool tests

**Dependencies:** 3.2 (agent location tracking), beacon's existing `/spawn` endpoint

#### ✅ 3.10 Coordinator & Beacon Test Coverage

**Status:** Complete

Comprehensive test coverage for both `drone-coordinator` and `drone-beacon` packages.

**Coordinator tests (5 test files, ~200 tests):**

- `test/db.test.ts` — 76 tests covering Persona, Skill, Beacon, BeaconTrust, BeaconSession, SwarmSession, SwarmEvent, AgentLocation, Insight, Principle CRUD
- `test/knowledge.test.ts` — 13 tests for knowledge CRUD
- `test/storage.test.ts` — 11 tests for blob storage engine
- `test/routes.test.ts` — 134 tests covering all route files (health, personas, skills, beacons, knowledge, swarm, messages, insights, principles, spawn) including knowledge route-ordering, swarm large payload, session pipeline 409 transitions, detailed message relay/broadcast with fetch stubbing, and spawn relay routes
- `test/auth.test.ts` — 11 tests for `isLocalRequest` and `createWebAuthMiddleware`
- `test/helpers/server.ts` — Shared harness (`makeApp`/`teardownApp`) for route tests

**Beacon tests (8 test files, ~160 tests):**

- `test/db.test.ts` — 60 tests covering Persona, Skill, AgentSession, Memory, Message, Spawn, Config, EventLog, KnowledgeCache, Insight, Principle CRUD
- `test/identity.test.ts` — 7 tests for Ed25519 keypair management
- `test/tls.test.ts` — 4 tests for TLS cert management
- `test/wiki-storage.test.ts` — 12 tests for wiki filesystem operations
- `test/ws-server.test.ts` — 11 tests for IP validation and connection management
- `test/coordinator-client.test.ts` — 14 tests for HTTP client with mocked http.request
- `test/routes.test.ts` — 80 tests covering all beacon route files (health, personas, skills, agents, memory, messages, spawn, config, events, insights, principles, sync)

**Total: 1151 tests across 57 test files (0 failures)**

---

### ✅ PHASE 4: drone-gateway

**Status:** Core complete; Matrix adapter and config-model refactor done; remaining adapters and control surfaces pending

Chat API integration layer — YOUR agents receive messages from chat platforms and respond back.

**Domain Language:**

- **Gateway** — the standalone service itself
- **Service Adapter** — a platform integration (Matrix, Telegram, Slack). Each adapter knows how to connect to that platform's API, authenticate, and translate between platform-specific message formats and the gateway's internal format.
- **Control Surface** — a configuration that maps a chat conversation (room, DM, channel) to a behavior. A control surface is attached to a service adapter.
- **Persona Assignment** — a control surface that routes all messages in a conversation to a specific persona
- **Swarm Console** — a control surface that exposes coordinator commands (spawn, status, terminate, list beacons, etc.)
- **Mention Router** — a control surface that watches for `!persona` (and eventually `!persona@gateway`) mentions and routes those messages to the specified persona
- **Discard Control Surface** — a built-in control surface that silently consumes messages (returns `{response:null, handled:true}`). Used for explicit "/dev/null" routing.
- **Conversation** — a single chat conversation identified by a `conversationId`. The adapter owns the routing scheme (room IDs, `dm:@peer:server`, etc.). The engine and control surfaces treat it as opaque.
- **Wildcard Control Surface** — a control surface attached to the reserved conversationId `"*"`, acting as a per-adapter catch-all. Configured via `_default_.json`.

**Architecture:**

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
│  │           Coordinator Client                    │ │
│  │  (HTTP to coordinator:8080, bearer token auth)  │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
              drone-coordinator:8080
              (web port, bearer token auth)
```

**Key design decisions:**

- New `drone-gateway` package in the monorepo (ESM, TypeScript, pnpm workspace)
- Folder-based config hierarchy (`config.json` + `adapters/<id>/adapter.json` + `adapters/<id>/conversations/<conv>.json`)
- Per-conversation dedicated control surface instances (never shared across conversations)
- Adapter owns conversation routing; control surfaces are context-ignorant
- First-match-wins dispatch: exact convId → wildcard `"*"` → unhandled
- Coordinator client talks to the web UI port (8080) with optional Bearer token auth
- Recommended deployment: on the coordinator's host (local/Tailnet bypass applies)
- Control surfaces are per-conversation, configured per adapter

#### ✅ 4.1 Gateway Core

**Status:** Complete

The core gateway package: engine loop, service adapter interface, control surface interface, coordinator client, config loading, CLI entry point, spawn backends, comprehensive test coverage, and architecture documentation.

**What's Built:**

- `drone-gateway/package.json` — ESM package scaffold, registered in pnpm workspace
- `drone-gateway/src/types.ts` — `DroneServiceAdapter`, `DroneControlSurface`, `GatewayConfig`, `SpawnSession`, `AdapterMessage`
- `drone-gateway/src/spawn-backend.ts` — `SpawnBackend` interface (spawn, send message, terminate)
- `drone-gateway/src/engine.ts` — `GatewayEngine`: adapter lifecycle, message routing loop, control surface evaluation (first-match wins), persona-assignment surface implementation
- `drone-gateway/src/coordinator-client.ts` — HTTP client for coordinator web port (spawn, list beacons, list agents, get spawn, list spawns, terminate spawn, send message)
- `drone-gateway/src/local-spawn-backend.ts` — Spawns `drone-agent` processes with `--output-json`, NDJSON communication over stdin/stdout, turn-complete detection
- `drone-gateway/src/coordinator-spawn-backend.ts` — Delegates to coordinator's web port via `CoordinatorClient`
- `drone-gateway/src/index.ts` — CLI entry point, arg parsing (`--config`, `--help`), config loading with validation, spawn backend creation, signal handling
- `drone-gateway/src/logger.ts` — Pino logger
- `drone-gateway/src/which.ts` — PATH resolution utility
- `drone-gateway/bin/drone-gateway` — CLI binary
- `drone-gateway/CONTEXT.md` — Domain language documentation
- `drone-gateway/docs/adr/001-gateway-architecture.md` — Architecture decision record

**Test Coverage (6 test files, 59 tests):**

| Test File                                | Tests | What's Tested                                                                          |
| ---------------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| `test/which.test.ts`                     | 5     | PATH resolution, not-found, empty PATH                                                 |
| `test/coordinator-client.test.ts`        | 18    | All 7 API methods, error handling, auth header                                         |
| `test/local-spawn-backend.test.ts`       | 11    | Process spawning, NDJSON parsing, session lifecycle, cleanup                           |
| `test/coordinator-spawn-backend.test.ts` | 6     | Coordinator delegation, idempotency, error handling                                    |
| `test/engine.test.ts`                    | 5     | Constructor, start/stop lifecycle, adapter validation                                  |
| `test/index.test.ts`                     | 14    | Arg parsing, config loading/validation, spawn backend selection, main() error handling |

**Key Files:**

- `drone-gateway/src/types.ts` — All gateway types
- `drone-gateway/src/engine.ts` — Gateway engine
- `drone-gateway/src/coordinator-client.ts` — Coordinator HTTP client
- `drone-gateway/src/local-spawn-backend.ts` — Local agent spawning
- `drone-gateway/src/coordinator-spawn-backend.ts` — Coordinator-based spawning
- `drone-gateway/src/index.ts` — CLI entry point

**Dependencies:** drone-core (shared types)

#### ✅ 4.2 Matrix Service Adapter

**Status:** Complete

Matrix chat platform integration. Connects to a Matrix homeserver via `matrix-js-sdk`, listens for messages in rooms and DMs, sends responses back with markdown→HTML rendering, read receipts, and typing notifications.

**What's Built:**

- `src/adapters/matrix.ts` — `MatrixServiceAdapter` implementing `DroneServiceAdapter`
- `matrix-js-sdk` dependency added to `package.json`
- DM detection via 2-joined-member heuristic; conversationId format `dm:@peer:server`
- Room allowlist (`rooms[]` config) + DMs always included
- Best-effort E2EE crypto initialization (warns on failure, degrades to unencrypted)
- Markdown→HTML rendering via `BasicMarkdownRenderer` (code fences, inline code, bold, italic, links, lists, paragraphs)
- Read receipts and typing notifications on outgoing messages
- Graceful stop: `client.stopClient()` flushes crypto/sync store — does NOT delete `dataPath`
- Auto-join allowlisted room invites
- DM room lookup (existing) with fallback logging (no auto-create)

**Config-model refactor (delivered alongside 4.2):**

- Folder-based config hierarchy: `config.json` + `adapters/<id>/adapter.json` + `adapters/<id>/conversations/<conv>.json`
- `src/config/load.ts` — Async folder-walking config loader
- `src/config/files.ts` — Lossless `convIdToFilename`/`filenameToConvId` encoding for special characters
- `src/types.ts` — New `ControlSurfaceSpec`, `ResolvedServiceAdapter`, `MarkdownRenderer`, `RenderedMessage` types
- `src/engine.ts` — Per-conversation dedicated control surface instances (`Map<adapterId, Map<convId, DroneControlSurface[]>>`), exact-then-`"*"` wildcard dispatch, `discard` built-in surface type
- `src/markdown.ts` — `BasicMarkdownRenderer` behind swappable `MarkdownRenderer` interface
- `docs/adr/002-gateway-config-model.md` — Architecture decision record
- `CONTEXT.md` — Updated with Conversation, Wildcard, Discard terms and folder layout

**Test Coverage (3 new test files, ~28 new tests):**

| Test File                                | Tests | What's Tested                                                                          |
| ---------------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| `test/markdown.test.ts`                  | 12    | Code fences, inline code, bold, italic, links, lists, paragraphs, HTML escaping        |
| `test/config-load.test.ts`               | 8     | convId↔filename round-trips, validation, wildcard encoding                             |
| `test/matrix-adapter.test.ts`            | 16    | Client creation, crypto init, DM/room routing, allowlist, own-msg skip, backlog skip, sendMessage with HTML+receipt+typing, stop lifecycle, dataPath persistence |

**Key Files:**

- `drone-gateway/src/adapters/matrix.ts` — Matrix adapter
- `drone-gateway/src/markdown.ts` — Markdown renderer
- `drone-gateway/src/config/load.ts` — Folder config loader
- `drone-gateway/src/config/files.ts` — Filename encoding
- `drone-gateway/src/types.ts` — Reshaped types
- `drone-gateway/src/engine.ts` — Refactored engine with per-conversation instances + discard
- `drone-gateway/docs/adr/002-gateway-config-model.md` — ADR

**Dependencies:** 4.1 (gateway core), `matrix-js-sdk` (new)

**Appservice (bridge mode) deferred to Phase 5 as a moonshot.**

#### ✅ 4.3 Persona Assignment Control Surface

**Status:** Complete (verified 2026-07-07)

Routes all messages in a conversation to a specific persona. Implemented in `drone-gateway/src/engine.ts` via `createPersonaAssignmentSurface()` (dispatched by `createControlSurface()` for control-surface type `'persona-assignment'`).

**What's Built:**

- `conversationId → personaId` mapping via control surface config
- Uses the configured spawn backend (coordinator `POST /spawn` or local spawn) to launch agents
- Session reuse across multiple messages in the same conversation
- First-match-wins control surface evaluation in the engine loop
- Dedicated per-conversation instance (no convId re-check needed — engine guarantees it)

**Key Files:**

- `drone-gateway/src/engine.ts` — `createPersonaAssignmentSurface()` + `createControlSurface()`

**Dependencies:** 4.1 (gateway core), 3.9 (spawn routing)

#### ⏳ 4.4 Swarm Console Control Surface

**Status:** Not started

Exposes coordinator commands as chat-accessible commands. Users can type commands like `!spawn`, `!status`, `!beacons`, `!terminate` to manage the swarm from chat.

**Key considerations:**

- Command parsing and dispatch
- Maps to coordinator client methods (spawn, list beacons, list agents, get spawn, list spawns, terminate)
- Response formatting for chat readability

**Dependencies:** 4.1 (gateway core), 3.9 (spawn routing)

#### ⏳ 4.5 Mention Router Control Surface

**Status:** Not started

Watches for `!persona` and `!persona@beaconId` mentions in a conversation and routes those messages to the specified persona. E.g., `!coder fix this bug` spawns a coder agent with that task. Should also support `!coder@beaconId fix this bug` to route to a specific beacon.

**Key considerations:**

- Parses `!personaId rest of message` and `!personaId@beaconId rest of message` syntax
- Falls through (unhandled) if no mention is detected, allowing other control surfaces to process the message
- Can be combined with persona assignment in the same room (ordered array)

**Dependencies:** 4.1 (gateway core), 3.9 (spawn routing)

#### ⏳ 4.6 Telegram Service Adapter

**Status:** Not started

Telegram bot integration. Connects via the Bot API, listens for messages in groups and DMs, sends responses back.

**Dependencies:** 4.1 (gateway core)

#### ⏳ 4.7 Slack Service Adapter

**Status:** Not started

Slack bot/app integration. Connects via Slack Events API or Socket Mode, listens for messages in channels and DMs, sends responses back.

**Dependencies:** 4.1 (gateway core)

---

### 🔜 PHASE 5: Advanced Features

**Status:** Design phase (portions implemented — see 5.3)

Advanced swarm capabilities for YOU, built on phases 1-4.

#### 5.1 Conversation Log Migration

Adds `conversation`/`session`/`log` as a supported asset type in the migration tool, enabling promotion of session logs from local to swarm scopes.

**Note (verified 2026-07-07):** The `AssetType` union in `drone-agent/src/runtime/migration/types.ts` is still `'persona' | 'skill' | 'insight' | 'principle' | 'wiki'`. No `conversation`/`session`/`log` type exists, and the earlier "phase 5 placeholder comment" is no longer present in the codebase. This item remains unimplemented.

#### 5.2 Automated Learning Loop

The following features are aspirational and not yet implemented:

- **Background review fork**: A per-turn learning mechanism that runs in the background after each agent turn, extracting insights and patterns from the conversation.
- **Swarm review task**: A periodic task on the coordinator that identifies patterns across all beacons' sessions and derives shared principles or knowledge.
- **Automatic insight → principle derivation**: Rather than requiring manual `principles-store` calls, the system would automatically detect patterns across insights and suggest or create principles. (Currently manual only.)
- **Cross-beacon session search tool**: An agent-facing tool to search across all sessions in the swarm, building on the existing FTS5 infrastructure.

#### ✅ 5.3 Model Provider Plugin System

**Status:** Complete (verified 2026-07-07)

Model providers are implemented as plugins registered through the `llm` broker's `registerProvider()` capability — the "v2: Model providers become plugins" design goal is met.

**What's Built:**

- `llm` broker plugin (`drone-agent/src/plugins/llm/index.ts`) exposes a `DroneLlmCapability` with `registerProvider()` / `unregisterProvider()`
- Five provider plugins register through it: `ollama` (default-enabled), `openai`, `anthropic`, `openrouter`, `echo`
- The provider set is **not closed** — any plugin (including external disk-loaded plugins) can call `llmCap.registerProvider()` to add a new provider at runtime
- Broker sorts providers by precedence and auto-activates based on `config.llm.provider`; `/model --provider <id>` switches at runtime

**Key Files:**

- `drone-agent/src/plugins/llm/index.ts` — LLM broker + capability
- `drone-agent/src/plugins/ollama.ts`, `openai/index.ts`, `anthropic/index.ts`, `openrouter/index.ts`, `echo/index.ts` — provider plugins

**Caveat:** All five providers are still compiled into the `staticBuiltInPlugins` array in `drone-agent/src/plugins/index.ts`; they are not hot-loaded from disk, but the registration API is fully dynamic.

#### 5.4 Distributed Memory & Task Routing

- Vector search for global session/memory retrieval
- Distributed task routing within YOUR swarm
- Route to node with best model for task

**Note (verified 2026-07-07):** `search__semantic` in `drone-agent/src/plugins/search.ts` is still a placeholder stub; no vector/embedding search exists. Unimplemented.

#### 5.5 Web UI Management Console

**Status:** Not started

Extend the coordinator web UI (built in 3.7) from monitoring-only to a full management console. Adds create/edit/delete forms for all resource types.

**Planned features:**

- **Persona management** — create, edit, and delete swarm personas via the UI
- **Skill management** — create, edit, and delete swarm skills
- **Wiki management** — create, edit, and delete wiki pages with a markdown editor
- **Knowledge management** — browse, edit, and delete knowledge entries
- **Beacon management** — approve/reject pending beacons, view trust details
- **Insights & Principles management** — browse and delete insights/principles
- **Session management** — force-close stale sessions
- **Wiki browsing** — full wiki reader with search, navigation, and wiki-link traversal

**Dependencies:** 3.7 (web UI foundation)

#### 5.6 Bootstrap Swarm Workflow

**Status:** Not started

A guided workflow (`bootstrap.swarm`) to set up beacon/coordinator connection, configure swarm mode, and register with a beacon. Currently the bootstrap plugin only has `bootstrap.project` and `bootstrap.user`.

**Note (verified 2026-07-07):** No `bootstrap.swarm` workflow exists; only `bootstrap.analyze`, `bootstrap.project`, and `bootstrap.user` are present in `drone-agent/src/plugins/bootstrap/index.ts`. Unimplemented.

---

## Dependencies Between Phases

```
Phase 1 (drone-agent)
    │
    ▼ (requires swarm plugin)
Phase 2 (drone-beacon)
    │
    ▼ (beacon connects to coordinator)
Phase 3 (drone-coordinator)
    │
    ▼ (gateway relays messages)
Phase 4 (drone-gateway)
    │
    ▼ (built on all above)
Phase 5 (Advanced)
```

**Key Insight:** Each phase works without the one above it, enabling incremental adoption.

---

## Development Commands

| Command           | Purpose                      |
| ----------------- | ---------------------------- |
| `pnpm build`      | Compile all packages         |
| `pnpm typecheck`  | Type-check all packages      |
| `pnpm test`       | Run all tests (vitest)       |
| `pnpm test:watch` | Watch mode                   |
| `pnpm lint`       | ESLint + Prettier            |
| `pnpm clean`      | Remove all dist/ directories |

---

## Open Questions

- Recovery: Does agent `git commit` before every tool call?
- Cross-beacon file access: "Don't support it, use git for merge coordination"
- Default experience: Ephemeral vs persistent (persona as default)
- Hot-reload: Skills and personality on next LLM turn without restart
- Sync vs independence: Beacon down → your agent works with cached state (eventually consistent)
- Coordinator maintenance: Must always have beacon on same host
- How many agents should one human manage? (Start small, expand as needed)

---

## Success Criteria

1. **Phase 1:** Agent can bootstrap itself and work on its own codebase ✅
2. **Phase 2:** Your multiple agents on same host share YOUR skills/personas/memory via beacon ✅
3. **Phase 3:** YOUR multiple hosts coordinate via coordinator; migration tool moves assets between scopes; monitoring web UI for viewing swarm state; comprehensive test coverage; inter-beacon spawn routing ✅
4. **Phase 4:** Chat messages from Discord/Slack spawn YOUR agents and get responses (partial — gateway core + persona-assignment + Matrix adapter + config-model refactor done; remaining adapters and control surfaces pending)
5. **Phase 5:** YOUR distributed memory, intelligent task routing, multi-model support (multi-model ✅ via 5.3), automated learning (pending)

---

## Multi-User Clarification

> **Q: What if I want multiple humans to use drone?**
>
> **A:** Use an MCP server designed for multi-user coordination. Examples:
>
> - MCP Jam
> - CrewAI Cloud
> - Custom MCP server for your team
>
> The drone swarm intentionally focuses on being the best possible **single-user** personal AI workforce. Adding multi-user permissions, sharing, and team management would complicate the core experience and dilute the single-user focus.

---

_Last updated: 2026-07-08_
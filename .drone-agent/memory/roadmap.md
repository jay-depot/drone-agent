---
key: roadmap
tags:
  - swarm
  - roadmap
  - drone-agent
  - planning
created: 2026-06-24T01:49:32.293Z
updated: 2026-06-29T20:19:46.800Z
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
│                   drone-gateway                      │
│  (Chat APIs: Matrix, Discord, Slack, relaying       │
│   messages into swarm, launching agents on demand)  │
│  *Single-user: messages routed to YOUR agents        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                 drone-coordinator                    │
│  (Personal control plane: web UI, task management,  │
│   your skills, personas, memory, identities)       │
│  *Single-user: manages YOUR agents only            │
│  *must* have a beacon on the same host              │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                  drone-beacon                       │
│  (Local coordination: YOUR system-wide skills,    │
│   memories, inter-agent communication)            │
│  *Single-user: serves YOUR agents on this host     │
│  runs on same host or on LAN                       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                   drone-agent                       │
│  (CLI/TUI: LLM, tools, MCP client, plugins)        │
│  *YOUR agent - works standalone or in swarm        │
│  runs anywhere, works standalone                   │
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
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Local Review │───▶│ Save Local  │───▶│ Update      │
│ (optional)   │    │ Session     │    │ Memory      │
└──────────────┘    └──────────────┘    └──────────────┘
         │                                │
         │         ┌─────────────────────┘
         │         ▼
         │  ┌────────────────────────┐
         │  │ Push to Coordinator    │
         │  │ (if enabled)           │
         │  └────────────────────────┘
         │         │
         ▼         ▼
┌─────────────────────────────────────────┐
│ COORDINATOR (YOUR swarm hub)             │
│ - Store Sessions                         │
│ - Index FTS (searchable)                │
│ - Swarm Review (identify patterns)       │
│ - Broadcast Knowledge                    │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ ALL YOUR BEACONS SYNC                    │
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

**Status:** Substantially Complete — core infrastructure, security, session storage, knowledge management, wiki, insights/principles, and migration tool are all implemented. A few small items remain.

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
- `drone-agent/src/runtime/migration-service.ts` — Core migration logic (827 lines)
- `drone-agent/test/migration.test.ts` — Tests (612 lines)

#### ⏳ 3.7 Make `--https` Default

**Status:** Pending

Certificate auto-generation already exists on both beacon and coordinator. The change is to flip the default from `false` to `true`:

- Coordinator: `process.env.COORDINATOR_HTTPS === 'true'` → `process.env.COORDINATOR_HTTPS !== 'false'`
- Beacon: Same pattern for `BEACON_HTTPS` and `COORDINATOR_HTTPS`

**Nice-to-have:** Add a pure Node.js certificate generation fallback (using `crypto`) for environments without `openssl` CLI.

#### ⏳ 3.8 Inter-Beacon Spawn Routing

**Status:** Not started

The beacon already has a local spawn API (`POST /spawn`). The coordinator tracks agent locations. What's needed:

1. New `POST /spawn` route on coordinator that accepts `{ targetBeaconId, personaId?, task?, config? }`
2. Logic to look up the target beacon's host:port and forward the request (mirrors the existing message relay pattern in `messages.ts`)
3. Optionally, a `beaconSelector: 'any'` mode that picks the least-loaded beacon

The beacon's existing `/spawn` endpoint is ready to accept forwarded requests — no changes needed on the beacon side.

#### ⏳ 3.9 Bootstrap Swarm Workflow

**Status:** Not started

A guided workflow (`bootstrap.swarm`) to set up beacon/coordinator connection, configure swarm mode, and register with a beacon. Currently the bootstrap plugin only has `bootstrap.project` and `bootstrap.user`.

#### ⏳ 3.10 Coordinator Test Coverage

**Status:** Minimal (1 test file: `knowledge.test.ts`)

The coordinator needs test coverage for its routes and database layer.

---

### 🔜 PHASE 4: drone-gateway

**Status:** Not yet designed

Chat API integration layer - YOUR agents receive messages from chat platforms.

**Goals:**

- Connect to chat APIs (Matrix, Discord, Slack, etc.)
- Relay messages into YOUR assigned personas in the swarm
- Launch new agent instances when needed to handle conversations
- Bidirectional: respond back to chat platforms

**Implementation:**

- Standalone service
- YOUR authentication for each platform
- Message parsing and persona routing (YOUR routing)

---

### 🔜 PHASE 5: Advanced Features

**Status:** Design phase

Advanced swarm capabilities for YOU, built on phases 1-4.

#### 5.1 Conversation Log Migration

The migration tool already has a placeholder comment: _"Conversation log import is a phase 5 concern."_ This would add `conversation`/`session`/`log` as a supported asset type, enabling promotion of session logs from local to swarm scopes.

#### 5.2 Automated Learning Loop

The following features are aspirational and not yet implemented:

- **Background review fork**: A per-turn learning mechanism that runs in the background after each agent turn, extracting insights and patterns from the conversation.
- **Swarm review task**: A periodic task on the coordinator that identifies patterns across all beacons' sessions and derives shared principles or knowledge.
- **Automatic insight → principle derivation**: Rather than requiring manual `principles-store` calls, the system would automatically detect patterns across insights and suggest or create principles.
- **Cross-beacon session search tool**: An agent-facing tool to search across all sessions in the swarm, building on the existing FTS5 infrastructure.

#### 5.3 Model Provider Plugin System

- v1: Hardcoded Ollama
- v2: Model providers become plugins
- Different hosts may have different models

#### 5.4 Distributed Memory & Task Routing

- Vector search for global session/memory retrieval
- Distributed task routing within YOUR swarm
- Route to node with best model for task

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
3. **Phase 3:** YOUR multiple hosts coordinate via coordinator; migration tool moves assets between scopes ✅
4. **Phase 4:** Chat messages from Discord/Slack spawn YOUR agents and get responses
5. **Phase 5:** YOUR distributed memory, intelligent task routing, multi-model support, automated learning

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

_Last updated: 2026-06-29_

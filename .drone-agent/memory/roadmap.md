---
key: roadmap
tags:
  - swarm
  - roadmap
  - drone-agent
  - planning
created: 2026-06-24T01:49:32.293Z
updated: 2026-06-25T00:06:18.986Z
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
│   messages into swarm, launching agents on demand) │
│  *Single-user: messages routed to YOUR agents       │
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
│  (Local coordination: YOUR system-wide skills,      │
│   memories, inter-agent communication)             │
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
  shareSkills: boolean,       // Sync your skills across your beacons
  localNudgeInterval: number,      // default: 10 turns
  swarmReviewIntervalMinutes: number,
  searchableByDefault: boolean,
}
```

---

## Swarm Migration Tool

A CLI tool for moving your assets between scopes within your personal swarm.

### Purpose

As you build up valuable personas, skills, and memories locally, you can promote them to higher scopes for broader access:

- **Project → User**: Move project-specific assets to your user scope
- **User → Beacon**: Make your assets available to all agents on this host
- **Beacon → Coordinator**: Make assets available across all your beacons

### Scope Progression (All Yours)

```
┌─────────────────────────────────────────────────────┐
│              COORDINATOR (Your Swarm-wide)         │
│  Your personas, skills, memory on ALL your beacons│
└─────────────────────────┬───────────────────────────┘
                          │ promote
                          ▼
┌─────────────────────────────────────────────────────┐
│              BEACON (Your Host-wide)                │
│  Your personas, skills, memory on this host       │
└─────────────────────────┬───────────────────────────┘
                          │ promote
                          ▼
┌─────────────────────────────────────────────────────┐
│              USER (Your User-level)                 │
│  Your default personas, skills, memories           │
└─────────────────────────┬───────────────────────────┘
                          │ promote
                          ▼
┌─────────────────────────────────────────────────────┐
│              PROJECT (Your Project-specific)        │
│  Your project-scoped personas, skills, memories    │
└─────────────────────────────────────────────────────┘
```

### Commands

```bash
# List your migrate-able assets
drone-migrate --list

# Promote specific asset to higher scope
drone-migrate --persona "my-persona" --to beacon
drone-migrate --skill "deploy-helm" --to coordinator
drone-migrate --memory "project-context" --to beacon

# Batch promote all from one scope to another
drone-migrate --from user --to beacon

# Pull down (demote) swarm assets to local
drone-migrate --pull --scope coordinator --to user
```

### Implementation

**Scope Flags:**

- `project` - Only visible in current project
- `user` - Visible to all your projects on this user account
- `local` / `beacon` - Visible to all YOUR agents connected to this beacon
- `coordinator` / `swarm` - Visible to your entire swarm

**No Multi-User Complications:**

- No permissions to manage
- No approval queues for sharing
- No conflict resolution with other users
- Simple overwrite/merge for conflicts (your choice)

**Key Files:**

- `drone-agent/src/cli/migrate.ts` - CLI commands
- `drone-agent/src/runtime/migration-service.ts` - Asset promotion logic
- `drone-beacon/src/routes.ts` - `/migrate` endpoints
- `drone-coordinator/src/routes.ts` - `/swarm/migrate` endpoints

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

**Self-Improvement Integration:**

- Background review fork for per-turn learning
- Skill creation/management tools
- Memory read/write for local knowledge
- Insights system (principles, patterns)

**Migration Tool Integration:**

- CLI commands for migration (`drone migrate`)
- Scope field on all assets (project/user/local/coordinator)
- Local migration service

**Key Files:**

- `drone-agent/src/index.tsx` - CLI entry point
- `drone-agent/src/runtime/plugin-engine.ts` - Plugin lifecycle
- `drone-agent/src/runtime/conversation-service.ts` - LLM loop
- `drone-agent/src/plugins/index.ts` - Built-in plugins
- `drone-agent/src/plugins/swarm/index.ts` - Swarm plugin (connects to beacon)
- `drone-core/src/index.ts` - Shared types

**Future: Swarm Setup Workflow**

- The bootstrap plugin will be updated to add a guided workflow for setting up a swarm
- Interactive prompts to configure beacon, coordinator, and gateway
- Simplifies the "getting started" experience for new swarm users

---

### ✅ PHASE 2: drone-beacon (MOSTLY COMPLETE)

**Status:** Substantially implemented, needs testing/documentation

Local coordination layer for YOUR swarm on one machine.

**What's Built:**

- Fastify HTTP server (port 3457 by default)
- SQLite database (better-sqlite3) with tables:
  - `personas` (id, name, description, systemPrompt, scope, createdAt, updatedAt)
  - `skills` (id, name, description, trigger, body, scope, createdAt, updatedAt)
  - `agent_sessions` (id, personaId, connectedAt, lastActivity)
- REST API endpoints:
  - `/health` - Health check
  - `/personas` - CRUD for your personas
  - `/skills` - CRUD for your skills
  - `/agents` - YOUR agent session management (register, heartbeat, unregister)
  - `/sync` - Sync YOUR personas/skills from coordinator
- Coordinator client for registering beacon and fetching YOUR assets
- CLI arguments: `--port`, `--host`, `--db`, `--coordinator-host`, `--coordinator-port`, `--id`, `--name`

**Self-Improvement Integration:**

- Local session storage (for offline operation)
- Your local memory (your preferences)
- Push to coordinator on session end (**TODO**)
- Sync knowledge from coordinator (**TODO**)

**Migration Tool Integration:**

- `/migrate` API endpoints for pushing YOUR assets upward
- Scope-aware CRUD (filter by scope)

**How It Works:**

1. Your agent enables `swarm` plugin
2. Plugin registers your agent session with beacon via POST `/agents`
3. Plugin fetches YOUR personas/skills from beacon (scope: local vs coordinator)
4. Heartbeat every 30 seconds to keep session alive
5. On shutdown, agent unregisters via DELETE `/agents/:id`

**What's Missing / TODO:**

- [ ] Inter-agent messaging (communication channel between YOUR agents)
- [ ] Agent spawn execution (executing incoming spawn requests)
- [ ] Memory store (beacon-scoped shared memory for YOUR agents)
- [ ] Event log
- [ ] Proper integration testing between agent and beacon
- [ ] README documentation
- [ ] Beacon-level config override
- [ ] Auto-download of beacon binary for agent

---

### 🔜 PHASE 3: drone-coordinator

**Status:** Placeholder exists, not yet implemented

Personal control plane for YOUR swarm across machines.

**Goals:**

- Web UI for monitoring YOUR agents in the swarm
- Task management and inter-beacon agent spawning
- YOUR swarm-wide personas, skills, and memory store
- YOUR session registry (aggregated from YOUR beacons)
- Coordinator management persona
- SQLite or Postgres persistence (your choice)
- Must have a beacon on same host (for self-maintenance)

**Why No Multi-User:**

- There's only one user: YOU
- No permissions, no sharing, no team management
- If you need multi-user, use an MCP server (e.g., MCP Jam, CrewAI Cloud)

**Self-Improvement Role:**

- Global session storage (YOUR beacon sessions searchable)
- YOUR knowledge registry (skills, patterns, facts, preferences)
- Swarm review task (identifies patterns across YOUR beacons)
- Broadcast mechanism (propagates learned knowledge to YOUR beacons)

**Implementation Phases:**

| Phase | Feature                | Description                                               |
| ----- | ---------------------- | --------------------------------------------------------- |
| 3.1   | Shared Session Storage | `swarm_sessions`, `swarm_messages` tables with FTS5       |
| 3.2   | Enhanced Sync          | Bidirectional beacon → coordinator sync for YOUR data     |
| 3.3   | Global Memory & Skills | `knowledge` table (your skill, pattern, preference, fact) |
| 3.4   | Swarm Learning Tasks   | Periodic swarm review on YOUR patterns                    |
| 3.5   | Global Search          | Search across all YOUR agents' sessions                   |

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

**Swarm Memory Architecture:**

- Event log (append-only) - most flexible
- KV store with TTL - structured data
- Vector store with agent-scoped namespaces - most powerful
- Default: Event log + vector store; periodic agent promotes facts

**Inter-Beacon Agent Spawning:**

- Beacon A asks coordinator to tell Beacon B to spawn an agent
- Distributed task routing within YOUR swarm
- Route to node with best model for task

**Model Provider Plugin System:**

- v1: Hardcoded Ollama
- v2: Model providers become plugins
- Different hosts may have different models

**Swarm Intelligence:**

- What one of YOUR beacons learns, all YOUR beacons know
- Your multiple beacons learn simultaneously
- Patterns from your beacon A help your beacon B
- Coordinator identifies patterns across YOUR entire swarm

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
2. **Phase 2:** Your multiple agents on same host share YOUR skills/personas/memory via beacon (mostly ✅)
3. **Phase 3:** YOUR multiple hosts coordinate via coordinator; web UI shows YOUR swarm status
4. **Phase 4:** Chat messages from Discord/Slack spawn YOUR agents and get responses
5. **Phase 5:** YOUR distributed memory, intelligent task routing, multi-model support

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

_Last updated: 2026-06-25_

---
key: roadmap
tags:
  - swarm
  - roadmap
  - drone-agent
  - planning
created: 2026-06-24T01:49:32.293Z
updated: 2026-06-24T01:52:12.407Z
---

# Swarm Roadmap

## Project Vision
The `drone` agent platform aims to be "the Arch of AI agents": minimalist out of the box, flexible, and capable of becoming an intricate, customized and powerful, distributed system.

**Design Principles:**
- Minimalist core: Works with almost nothing enabled; plugins add functionality
- Model-centric: No hundreds of lines of system prompts; let the LLM figure it out with tools
- Project-first: Config cascades (Project > User > Beacon > Coordinator > System defaults)
- Self-dogfooding: The project should be developed using itself

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   drone-gateway                      │
│  (Chat APIs: Matrix, Discord, Slack, relaying       │
│   messages into swarm, launching agents on demand) │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                 drone-coordinator                    │
│  (Cross-host control plane: web UI, task management│
│   swarm-wide skills, personas, memory, identities) │
│  *must* have a beacon on the same host              │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                  drone-beacon                       │
│  (Local coordination: system-wide skills, memories │
│   inter-agent communication, agent spawning)       │
│  runs on same host or on LAN                        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                   drone-agent                       │
│  (CLI/TUI: LLM, tools, MCP client, plugins)        │
│  runs anywhere, works standalone                   │
└─────────────────────────────────────────────────────┘
```

**Failure Mode: Graceful Degradation**
- **Offline:** Agent works with project/user config files. Beacon adds host-wide skills/memory.
- **LAN:** Agents share via beacon on the same network.
- **Cloud/VPN:** Cross-site coordination via coordinator.

---

## Phase Roadmap

### ✅ PHASE 1: drone-agent (COMPLETE)
**Status:** Complete

The standalone coding agent with plugin architecture.

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

### ✅ PHASE 2: drone-beacon (MOSTLY COMPLETE)
**Status:** Substantially implemented, needs testing/documentation

Local coordination layer for swarm mode.

**What's Built:**
- Fastify HTTP server (port 3457 by default)
- SQLite database (better-sqlite3) with tables:
  - `personas` (id, name, description, systemPrompt, scope, createdAt, updatedAt)
  - `skills` (id, name, description, trigger, body, scope, createdAt, updatedAt)
  - `agent_sessions` (id, personaId, connectedAt, lastActivity)
- REST API endpoints:
  - `/health` - Health check
  - `/personas` - CRUD for personas
  - `/skills` - CRUD for skills
  - `/agents` - Agent session management (register, heartbeat, unregister)
  - `/sync` - Sync personas/skills from coordinator
- Coordinator client for registering beacon and fetching swarm assets
- CLI arguments: `--port`, `--host`, `--db`, `--coordinator-host`, `--coordinator-port`, `--id`, `--name`

**Key Files:**
- `drone-beacon/src/index.ts` - Main entry point, CLI parsing
- `drone-beacon/src/db.ts` - SQLite operations
- `drone-beacon/src/routes.ts` - REST API routes
- `drone-beacon/src/coordinator-client.ts` - Coordinator communication
- `drone-beacon/src/types.ts` - TypeScript interfaces
- `drone-beacon/src/logger.ts` - Pino logger

**How It Works:**
1. Agent enables `swarm` plugin
2. Plugin registers agent session with beacon via POST `/agents`
3. Plugin fetches personas/skills from beacon (scope: local vs coordinator)
4. Heartbeat every 30 seconds to keep session alive
5. On shutdown, agent unregisters via DELETE `/agents/:id`

**What's Missing / TODO:**
- [ ] Inter-agent messaging (communication channel)
- [ ] Agent spawn execution (executing incoming spawn requests)
- [ ] Memory store (beacon-scoped shared memory)
- [ ] Event log
- [ ] Proper integration testing between agent and beacon
- [ ] README documentation
- [ ] Beacon-level config override
- [ ] Auto-download of beacon binary for agent

**Usage:**
```bash
# Start beacon
cd drone-beacon && pnpm start

# Or with custom settings
node ./bin/drone-beacon --port 3457 --name my-beacon --coordinator-host localhost --coordinator-port 3458
```

---

### 🔜 PHASE 3: drone-coordinator
**Status:** Placeholder exists, not yet implemented

Cross-host control plane for managing beacons.

**Goals:**
- Web UI for monitoring agents in the swarm
- Task management and inter-beacon agent spawning
- Swarm-wide personas, skills, and memory store
- Session registry (aggregated from beacons)
- Coordinator management persona
- SQLite or Postgres persistence (user's choice)
- Must have a beacon on same host (for self-maintenance)
**Implementation:**
- `drone-coordinator/` directory exists as placeholder
- Needs `README.md` implementation
- Cross-beacon coordination

**Features:**
- Central repository for swarm-wide skills
- Agent identity management
- Inter-beacon agent spawn requests
- Route spawn requests to best node for task
- Event log + vector store for swarm memory

---

### 🔜 PHASE 4: drone-gateway
**Status:** Not yet designed

Chat API integration layer.

**Goals:**
- Connect to chat APIs (Matrix, Discord, Slack, etc.)
- Relay messages into assigned personas in the swarm
- Launch new agent instances when needed to handle conversations
- Bidirectional: respond back to chat platforms
**Implementation:**
- Standalone service
- Authentication for each platform
- Message parsing and persona routing

---

### 🔜 PHASE 5: Advanced Features
**Status:** Design phase

Advanced swarm capabilities built on phases 1-4.

**Swarm Memory Architecture:**
- Event log (append-only) - most flexible
- KV store with TTL - structured data
- Vector store with agent-scoped namespaces - most powerful
- Default: Event log + vector store; periodic agent promotes facts

**Inter-Beacon Agent Spawning:**
- Beacon A asks coordinator to tell Beacon B to spawn an agent
- Distributed task routing
- Route to node with best model for task

**Model Provider Plugin System:**
- v1: Hardcoded Ollama
- v2: Model providers become plugins
- Different hosts may have different models
**Security/Identity:**
- Agent keypairs
- Coordinator as CA
- Trust-on-first-use with shared swarm secret
- Public key auth for network beacons

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

## Open Questions (for future phases)

- Recovery: Does agent `git commit` before every tool call?
- Cross-beacon file access: "Don't support it, use git for merge coordination"
- Default experience: Ephemeral vs persistent (persona as default)
- Hot-reload: Skills and personality on next LLM turn without restart
- Sync vs independence: Beacon down → agent works with cached state (eventually consistent)
- Coordinator maintenance: Must always have beacon on same host

---

## Success Criteria

1. **Phase 1:** Agent can bootstrap itself and work on its own codebase ✅
2. **Phase 2:** Multiple agents on same host share skills/personas/memory via beacon (mostly ✅)
3. **Phase 3:** Multiple hosts coordinate via coordinator; web UI shows swarm status
4. **Phase 4:** Chat messages from Discord/Slack spawn agents and get responses
5. **Phase 5:** Distributed memory, intelligent task routing, multi-model support
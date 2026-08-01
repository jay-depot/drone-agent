---
key: roadmap
tags:
  - roadmap
created: 2026-06-24T01:49:32.293Z
updated: 2026-08-01T19:52:10.524Z
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
  - External plugin loading with trust management (`~/.drone-agent/plugins/`, `<project>/.drone-agent/plugins/`)
- Built-in plugins: skills, persona, memory, lsp, mcp, git, compact, bootstrap
  - Also: subagent, terminal emulator, macros, lightpanda, session logging, focus, notepad, prompt-file, utility tools (calculator, string ops), TODO list, echo LLM provider (testing), LLM provider broker, multiple LLM providers (Anthropic, OpenAI, OpenRouter, Ollama), shared utilities (diff-renderer, patch-applier)
- Config system with cascade (Project > User > Default)
  - First-run setup wizard (LLM provider probing)
- Session management (disposable workers)
- Persona management (persistent identities)
- Skills system (load from disk)
- Memory system (JSON files in .drone-agent/)
- MCP client integration
- LSP integration with auto-download
- Context budgeting and compaction
- Self-improvement/insights system
- **Swarm plugin** for connecting to beacon
- Migration system (promote/demote skills and personas between scopes)

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
  - Also: messages (with 24h cleanup), spawns (lifecycle tracking), beacon_config, knowledge_cache
  - Memory TTL with periodic cleanup
- REST API endpoints for all CRUD operations
  - Wiki CRUD + search + lint
  - Insights/principles with coordinator proxy (`?scope=coordinator`)
  - Sync endpoints (manual sync trigger, event push, session registration)
  - Agent persona update (PATCH `/agents/:id/persona`)
- WebSocket server for inter-agent messaging
  - Cross-beacon message relay via coordinator
- Agent spawn execution (`/spawn` endpoint with `spawner.ts`)
  - Agent location tracking for cross-beacon routing
- Coordinator client for registering beacon and syncing assets
  - Beacon approval flow (pending → approved/rejected with polling)
  - Verification code (MitM protection comparing public key + TLS fingerprint)
  - Tool definition sync
  - Session pipeline (getSessions, getSessionLog, processSession, completeSessionProcessing)
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

#### 3.2 Shared Session Storage ✅
  - Stale session management (24h threshold, hourly detection)

#### 3.3 Global Memory & Skills ✅
  - Default persona/skill seeding (coordinator-wiki-librarian, coordinator-admin personas; memory-wiki skill)

#### 3.4 Swarm Knowledge Base (LLM Wiki) ✅
  - FTS5 full-text search on events
  - Knowledge sync protocol (push/pull with confidence-based conflict resolution)
  - Tool definitions system (built-in hidden tool seeding)

#### 3.5 Swarm-Wide Insights & Principles ✅

#### 3.6 Migration Tool ✅

#### ✅ 3.7 Web UI (Monitoring Dashboard) — Complete
  - WebSocket pub/sub for real-time updates
  - Dual-server architecture (API port 3456 + web port 8080 with auth)

#### ⏳ 3.8 Make `--https` Default — Pending

#### ✅ 3.9 Inter-Beacon Spawn Routing — Complete

#### ✅ 3.10 Coordinator & Beacon Test Coverage — Complete

---

### ✅ PHASE 4: drone-gateway

**Status:** Core complete; Matrix adapter and config-model refactor done; remaining adapters and control surfaces pending

#### ✅ 4.1 Gateway Core — Complete
  - Discard control surface (explicit /dev/null routing)
  - SQLite persistent store (Matrix sync + E2EE crypto key storage)
  - Cleanup subcommand (logout + delete local data)
  - Conversation ID ↔ filename encoding (lossless, reversible)
  - Two fully implemented spawn backends (local + coordinator)
  - Comprehensive test suite (12 files)

#### ✅ 4.2 Matrix Service Adapter — Complete
  - E2EE via Rust crypto, typing notifications, read receipts
  - DM detection (≤2 members), room allowlist
  - Markdown → HTML rendering

#### ✅ 4.3 Persona Assignment Control Surface — Complete

#### ⏳ 4.4 Swarm Console Control Surface — Not started

#### ⏳ 4.5 Mention Router Control Surface — Not started

#### ⏳ 4.6 Telegram Service Adapter — Not started

#### ⏳ 4.7 Slack Service Adapter — Not started

---

### 🔜 PHASE 5: Advanced Features

**Status:** Design phase (portions implemented — see 5.3)

#### 5.1 Conversation Log Migration — Not started

#### 5.2 Automated Learning Loop — Aspirational, not yet implemented

#### ✅ 5.3 Model Provider Plugin System — Complete

#### 5.4 Distributed Memory & Task Routing — Not started

#### ✅ 5.5 Web UI Management Console — Mostly Complete

#### 5.6 Bootstrap Swarm Workflow — Not started

#### 5.7 MCP Server Description Cache Invalidation

**Status:** Not started — deferred from MCP list/mount + server descriptions feature (2026-07-12)

Currently, MCP server descriptions generated by the LLM are cached at `~/.drone-agent/cache/mcp/server-descriptions.json` and never invalidated automatically. If a server's tool list changes significantly (e.g., a server adds a new toolset or changes its purpose), the cached description becomes stale.

**Options to revisit:**

- Tool-list-hash comparison: store a hash of tool names+descriptions in the cache entry, regenerate when the hash changes
- Manual refresh: provide a tool or CLI command to force regeneration
- TTL-based: regenerate after N days

**Dependencies:** None (can be done independently)

#### 5.8 List/Mount Pre-mounting Check-in

**Status:** Not started — deferred from tool reduction follow-up plan (2026-07-12)

After seeing list/mount live for a while (git, swarm, MCP), check in on whether some tools should be pre-mounted by default. Some commonly-used tools (e.g., git status, git diff) might benefit from being always available, while less common ones (e.g., git stash, swarm_spawn) stay in the cache. This is a UX decision that needs real-world observation.

**Dependencies:** Tool reduction follow-up plan must be executed first

#### 5.9 LSP Ergonomics for LLM

**Status:** In Progress — symbol-based resolution for all line/column-based LSP tools is implemented (all 12 position-sensitive tools support both `symbol` and `text` parameters, with a document-symbols → workspace-symbols fallback cascade), but reducing the total tool count and improving ergonomics is still in progress.

**Note:** Despite the symbol/text resolution being fully implemented, LSP tools are not being used as often as expected. This may indicate the tool count is still too high, or that the LLM needs better guidance on when to reach for LSP tools. This should be evaluated alongside the list/mount pattern (5.8) before further changes.

When we get to converting LSP to list/mount (or otherwise improving LSP tool ergonomics), we want to:

- Give the LLM a way to provide the text it's looking at for "cursor position" based tools (hover, go-to-definition, etc.) rather than requiring it to guess line/column numbers
- Figure out the correct cursor position ourselves from the text context
- Otherwise find ways to make LSP more ergonomic for the model

**Dependencies:** None (can be done independently, but should be informed by the list/mount pattern's real-world performance)

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

_Last updated: 2026-08-01 (backfilled sub-features under existing roadmap items from codebase review; added note to 5.9 about LSP tool usage frequency)_
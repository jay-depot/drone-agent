---
key: roadmap
tags:
  - roadmap
created: 2026-06-24T01:49:32.293Z
updated: 2026-09-26T18:37:49.896Z
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
│  (Personal control plane: web UI, task management,   │
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

**Full package set (8 workspace packages).** The four layers above are drawn from `drone-gateway`, `drone-coordinator`, `drone-beacon`, and `drone-agent`. Three supporting packages are not shown in the diagram:

- `drone-core` — shared types, contracts, config defaults, token estimation (used by every package)
- `drone-swarm-common` — shared beacon/coordinator utilities (TLS, wiki storage, spawner, verification, config-file loader, search primitives)
- `drone-coordinator-ui` — the coordinator's React/Vite web dashboard
- `drone-swarm` — a standalone REST CLI for the session pipeline and wiki (also not shown)

**Failure Mode: Graceful Degradation**

- **Offline:** Agent works with project/user config files. Beacon adds host-wide skills/memory.
- **LAN:** Your agents share via beacon on the same network.
- **Cloud/VPN:** Your agents coordinate via coordinator from anywhere.

**Key Insight:** All assets (personas, skills, memories) are **yours**. There's no permission system for multiple users because there's only one user.

---

## Self-Improvement System

The drone-agent swarm includes a **self-improving architecture** that enables continuous learning across all your agents.

> **Status (2026-09-26):** the *plumbing* exists — full session lifecycle with `ended` detection, `command|spawn` session-end triggers, a proven end-to-end auto pipeline (session end → headless librarian agent → **wiki** ingest, shipped as `bootstrap__swarm-memory`), insight/principle storage with prompt-fragment injection and swarm HTTP storage engines, and per-turn hook seams. The *learning semantics* do not: there is no per-turn background review, no automatic session→insight extraction, no automatic insight→principle derivation, and no session-reviewing persona. See Phase 5.2.

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

The `swarm` config section as it actually exists today (`drone-core/src/config-types.ts`):

```typescript
swarm: {
  knowledgeSync?: {
    enabled?: boolean;
    pushInsights?: boolean;
    pullOnStartup?: boolean;
    pullIntervalMinutes?: number;
  },
  sessionImport?: {
    maxChunks?: number;
    chunkTokenBudgetPercent?: number;
  },
  memory?: {
    enabled: boolean;        // swarm-memory RAG retrieval (opt-in)
    topK?: number;
    minScore?: number;
    anchors?: { tags: string[]; boostPerTag?: number; boostTitle?: string };
    window?: { maxQueryTokens?: number; maxQuerySegments?: number };
  },
  beaconHost?: string,
  beaconPort?: number,
  beaconUseHttps?: boolean,
  sessionId?: string,
}
```

> **Correction (2026-09-26):** an earlier version of this block listed `enabled`, `coordinatorUrl`, `shareSessions`, `shareMemory`, `shareSkills`, `localNudgeInterval`, `swarmReviewIntervalMinutes`, `searchableByDefault`. **None of those keys exist.** `coordinatorUrl` was removed from the agent config deliberately (the agent must never talk to the coordinator directly — the beacon is the sole coordinator-facing trust gate); the sharing/review knobs were superseded by `knowledgeSync` and `sessionImport`.

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
- Built-in plugins (**38** as of 2026-09-26): skills, persona, memory, lsp, mcp, git, **compaction**, bootstrap, subagent, terminal, macros, lightpanda, log (session logging), focus, notepad, prompt-file, utils (calculator + string ops), todo, echo, llm (provider broker), anthropic, openai, openrouter, ollama, config, exec, file, fetch, search, startup, wakelock, beancounter, self-improvement, swarm, and the four broker providers (skill-provider-project/-user, persona-provider-project/-user)
  - **Correction:** the plugin id is `compaction`, not `compact`; and the list above is the complete registration set (`drone-agent/src/plugins/index.ts`) — earlier revisions of this document omitted about fourteen plugins.
- Config system with cascade (Project > User > Default, plus Beacon/Coordinator underlays — see below)
  - First-run setup wizard (LLM provider probing)
- Session management (disposable workers)
- Persona management (persistent identities)
- Skills system (load from disk)
- Memory system (**Markdown files with YAML frontmatter** in `.drone-agent/memory/`)
  - **Correction:** earlier revisions said "JSON files"; the store serializes `.md` with a YAML frontmatter block.
- MCP client integration
- LSP integration with auto-download (tarball-based auto-install from npm / GitHub releases)
- Context budgeting and compaction
- Self-improvement/insights system
- **Swarm plugin** for connecting to beacon
- Migration system (promote/demote skills and personas between scopes) — `drone-agent/src/migrate.ts`, bin `drone-migrate`

**Config cascade (full):** default → coordinator underlay (precedence 50) → beacon underlay (precedence 75) → user/project files (precedence 100). When the swarm plugin is active, the beacon supplies the merged underlay via the `DroneConfigInjector` capability rather than the file-based loader.

**Key Files:**

- `drone-agent/src/index.tsx` - CLI entry point
- `drone-agent/src/runtime/plugin-engine.ts` - Plugin lifecycle
- `drone-agent/src/runtime/conversation-service.ts` - LLM loop
- `drone-agent/src/plugins/index.ts` - Built-in plugins
- `drone-agent/src/plugins/swarm/index.ts` - Swarm plugin (connects to beacon)
- `drone-agent/src/migrate.ts` - Migration CLI (`drone-migrate`)
- `drone-core/src/index.ts` - Shared types

---

### ✅ PHASE 2: drone-beacon (COMPLETE)

**Status:** Complete

Local coordination layer for YOUR swarm on one machine.

**What's Built:**

- Fastify HTTP server (port 3457 by default)
- SQLite database (better-sqlite3) with tables for personas, skills, agent sessions, memory, events, wiki, insights, principles
  - Also: messages (with 24h cleanup), spawns (lifecycle tracking), beacon_config, knowledge_cache, outbox, fragments, search_* (sqlite-vec)
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

**Status:** Substantially Complete — core infrastructure, security, session storage, knowledge management, wiki, insights/principles, migration tool, monitoring web UI, comprehensive test coverage, and inter-beacon spawn routing are all implemented. One item remains (3.8).

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

#### ⏳ 3.8 Make `--https` Default — PARTIAL (coordinator done, beacon diverges)

- **Coordinator:** HTTPS is now **on by default** (`useHttps: true`; `--no-https` disables). No env var is read.
- **Beacon:** HTTPS is still **off by default** (`BEACON_HTTPS === 'true'` required).
- **Remaining gaps:**
  1. Beacon/coordinator divergence — the two servers no longer share a default.
  2. `useHttps` in `--config-file` is declared and allowlisted by `drone-swarm-common/src/config-file.ts` but **ignored** by both servers (neither reads `merged.useHttps`).
  3. Env-var asymmetry — the beacon honors `BEACON_HTTPS`; the coordinator honors none.
  4. No doc states that the two servers differ.

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

#### 🚧 4.4 Swarm Console Control Surface — In progress (plan ready)

Locked design (2026-09-26, plan `plan-swarm-console-control-surface`): a gateway-side `swarm-console` control surface that parses dot-notation `swarm.<ns>.<cmd>` commands and maps each onto an existing coordinator REST endpoint. Direct REST, no LLM/agent. Optional per-conversation `allowedSenders` gate enforced by the engine. Engine-level surface registry extracted (surface types become registered factories). v1 command set: `swarm.help`, `swarm.broadcast`, `swarm.persona.{list,create,update,delete}`, `swarm.skill.{list,create,update,delete}`, `swarm.session.{list,get}`, `swarm.beacon.{list,status,spawn}`, `swarm.agent.{status,terminate,inject,persona}`.

Deferred (need new coordinator endpoints; tracked separately, see `followup-swarm-console-unbacked-commands`): `swarm.agent.focus`, `swarm.agent.interrupt`, `swarm.beacon.policy`, `swarm.session.search`, `swarm.session.delete`.

#### ⏳ 4.5 Mention Router Control Surface — Not started

#### ⏳ 4.6 Telegram Service Adapter — Not started

#### ⏳ 4.7 Slack Service Adapter — Not started

**Current gateway inventory (2026-09-26):** 2 control surfaces implemented (`persona-assignment`, `discard`), 1 service adapter implemented (Matrix). `telegram`, `slack`, `swarm-console`, and `mention-router` appear only in type comments, the glossary, and ADRs — never in executable code.

---

### 🔜 PHASE 5: Advanced Features

**Status:** Design phase (portions implemented — see 5.3, 5.4, 5.5, 5.9, 5.10)

#### 5.1 Conversation Log Migration — Not started

No conversation/session-log migration code or CLI exists. (`drone-agent/src/migrate.ts` handles skill/persona scope promotion only. `/swarm-session import` recreates an *old swarm session's context* into the current session — related but distinct.)

#### 5.2 Automated Learning Loop — Aspirational; plumbing present, semantics missing

What exists (reusable substrate): full session lifecycle with `ended` detection; `command|spawn` session-end triggers at beacon and coordinator; the `bootstrap__swarm-memory` end-to-end pipeline (session end → headless librarian → **wiki** ingest, with self-ingest guard, catch-up cron, atomic config writes, smoke test); insight/principle storage with prompt-fragment injection and swarm HTTP storage engines; per-turn hook seams (`onAfterToolCall`, `onConversationEvent`); a `reflect` persona premounting `insight`/`principle`/`mark_examined`.

What is missing (the actual feature): per-turn background review; automatic session→insight extraction (insights are recorded only by explicit tool calls); automatic insight→principle derivation; a *session-reviewing* persona (the librarian writes wiki pages only; `review` is a code reviewer; `reflect` is manual); cross-beacon session search; a periodic swarm-wide review task on the coordinator.

#### ✅ 5.3 Model Provider Plugin System — Complete

#### ✅ 5.4 Distributed Memory & Task Routing — PARTIALLY IMPLEMENTED (label corrected 2026-09-26)

- **Distributed memory retrieval IS implemented:** swarm-memory RAG over the merged beacon+coordinator wiki (ADR 179), with a bit-signature prefilter (ADR 181) and the retrieval trigger fixed to use the current user message (ADR 184). Opt-in via `swarm.memory`.
- **Deterministic spawn/message routing IS implemented:** inter-beacon spawn routing (3.9) and cross-beacon message relay.
- **Still missing:** an *intelligent* task-routing layer (e.g. route a task to the node with the best model for the job). That remains aspirational.

#### ✅ 5.5 Web UI Management Console — Complete

Topology, Beacons, Sessions, Personas (+editor), Skills (+editor), Wiki (+detail/editor/tag/graph), **Config** (+secrets), Login. The `/config` page is a real CRUD surface over `GET/PUT/DELETE /api/config/:key` with secret masking and stored-secret management (ADRs 209, 212).

#### 🚧 5.6 Bootstrap Swarm Workflow — PARTIAL

- **`bootstrap__swarm-memory` IS implemented** (`drone-agent/src/plugins/bootstrap/swarm-memory.ts`, ADR 180): writes `session-end-ingest.sh` + `catch-up-ingest.sh` into `~/.drone-swarm-memory/bin/`, merges the `sessionEnd` command trigger into the coordinator (and optionally beacon) config, installs an hourly catch-up cron, restarts ask-first, and runs a confirm-first smoke test.
- **Still missing:** the general `bootstrap__swarm` setup workflow (docs/agents/bootstrap-plugin.md still lists it under future workflows). Registered bootstrap workflows today: `bootstrap__project`, `bootstrap__user`, `bootstrap__swarm-memory`.

#### 5.7 MCP Server Description Cache Invalidation

**Status:** Not started — deferred from MCP list/mount + server descriptions feature (2026-07-12)

Currently, MCP server descriptions generated by the LLM are cached at `~/.drone-agent/cache/mcp/server-descriptions.json` and never invalidated automatically (an entry stores `generatedAt` but no code reads it for TTL; no tool-list hash; no manual refresh). If a server's tool list changes significantly, the cached description becomes stale.

**Options to revisit:**

- Tool-list-hash comparison: store a hash of tool names+descriptions in the cache entry, regenerate when the hash changes
- Manual refresh: provide a tool or CLI command to force regeneration
- TTL-based: regenerate after N days

**Dependencies:** None (can be done independently)

#### 5.8 List/Mount Pre-mounting Check-in

**Status:** Not started — deferred from tool reduction follow-up plan (2026-07-12)

The pre-mount *mechanism* now exists: every tool starts unmounted in the runtime-level `ToolRegistry` (only `runtime__list_tools`/`mount_tool`/`unmount_tool` are auto-mounted), and personas can opt in per-persona via `premountedTools`. There is **no global default pre-mount policy** — the "check-in" on whether some tools (e.g. git status, git diff) should be always-available is still open and needs real-world observation.

**Dependencies:** Tool reduction follow-up plan must be executed first

#### ✅ 5.9 LSP Ergonomics for LLM — COMPLETE (label corrected 2026-09-26)

- All position-sensitive LSP tools accept `symbol` / `text` / `surroundingText` (anchor-based resolution): `go_to`, `find_references`, `inspect`, `completion`, `call_hierarchy`, `code_action`, `rename`. The remaining three (`get_diagnostics`, `symbols`, `formatting`) are position-less by nature.
- The LSP tool count is down from 16 to **10** (registered in `plugin.ts`).
- Deferral is handled by the **runtime-level list/mount** pattern (`ToolRegistry` + `runtime__*` meta-tools); the plugin itself registers its tools directly and holds no cache.
- A header-phase `lsp-usage` prompt fragment teaches symbol-over-text and `surroundingText` disambiguation.
- **Open concern (unchanged):** LSP tools are still not used as often as expected. Evaluate alongside 5.8 before further changes.

#### 5.10 Multi-Language LSP Support — 5.10.1 COMPLETE; 5.10.2 NOT STARTED

**5.10.1 Auto-install for popular languages — COMPLETE.** 14 known server specs ship in `known-servers.ts` (typescript, pyright, rust-analyzer, gopls, lua-language-server, bash, yaml, json, dockerfile, taplo, css, html, svelte, intelephense), each with a pinned version and sha512 integrity. The installer supports five install types — `npm | cargo | pip | go | github-release` — though only `npm` and `go` are exercised by shipped specs (cargo/pip URL plumbing exists but is unused).

**5.10.2 LLM-assisted server suggestion — NOT STARTED.** No suggest/LLM path exists. Note the roadmap's own earlier hint holds up: a macro template or slash command the user can customize may be a better fit than a complex built-in system.

**Detection today:** root-marker eager detection + extension-based lazy start on file touch. No LLM involvement.

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
- **Hot-reload: PARTIAL.** Skills and personas can be reloaded explicitly (`/skills reload`, `skills__list{reload:true}`, `reloadPersonas()` capability, wizard paths reload after writes), but there is no automatic watcher or per-turn re-read — a disk edit is not picked up "on the next LLM turn" by default.
- Sync vs independence: Beacon down → your agent works with cached state (eventually consistent)
- **Coordinator maintenance: documented, not enforced.** "The coordinator must always have a beacon on the same host" is a deployment convention (README + design draft); no runtime check exists — the coordinator boots and serves fine with zero beacons. The only coupling is that self-maintenance (spawn) and coordinator session-end `spawn` triggers require a beacon.
- How many agents should one human manage? (Start small, expand as needed)

---

## Success Criteria

1. **Phase 1:** Agent can bootstrap itself and work on its own codebase ✅
2. **Phase 2:** Your multiple agents on same host share YOUR skills/personas/memory via beacon ✅
3. **Phase 3:** YOUR multiple hosts coordinate via coordinator; migration tool moves assets between scopes; monitoring web UI for viewing swarm state; comprehensive test coverage; inter-beacon spawn routing ✅
4. **Phase 4:** Chat messages from Discord/Slack spawn YOUR agents and get responses (partial — gateway core + persona-assignment + Matrix adapter + config-model refactor done; remaining adapters and control surfaces pending)
5. **Phase 5:** YOUR distributed memory, intelligent task routing, multi-model support (multi-model ✅ via 5.3; distributed memory retrieval ✅ via 5.4; intelligent routing + automated learning pending)

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

_Last updated: 2026-09-26 (full accuracy audit against HEAD `f2d487e`: corrected the plugin list and memory-format claims, corrected the `swarm` config block, fixed package inventory, corrected Phase 5.4/5.5/5.6/5.9/5.10 statuses, updated 3.8 to PARTIAL, and marked 4.4 in progress). Previous update: 2026-08-01 (added 5.10 Multi-Language LSP Support)._

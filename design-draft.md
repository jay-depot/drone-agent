# drone — Distributed Agent Architecture

Working name: **drone**. Short, punchy, implies autonomous coordinated units.

## Core Insight: Dual Agent Model

The term "agent" is overloaded. Two distinct meanings:

**Session agents** — `drone-agent` CLI instances. Workers. Disposable. Spawned, do a task, persist results, die. Stateless — session #492's memories don't matter when done.

**Persona agents** — Persistent identities ("unix-beard"). Accumulate knowledge, preferences, history. Don't act directly — get _embodied_ when a session agent picks up their persona.

```
drone-agent --persona unix-beard --task "check disk on all beacons"
```

Spawns a session, loads the persona's memory/skills, completes the task, writes results back to the persona's persistent store, then dies. Next invocation of the same persona picks up where things left off.

Session agents are workers. Personas are the stateful layer. You get disposability where it matters (worker failures don't lose context) and persistence where it matters (persona knowledge survives worker death).

**Important:** A session agent might run for a long time — e.g., an agent that lives on a messaging app receiving instructions. But even in those cases, the individual session is disposable. It can be respawned without losing much.

---

## Three-Layer Architecture

```
┌──────────────────────────────────────────────────┐
│                drone-coordinator                  │
│  (central hub: skills, identities, spawn requests)│
│  *must* have a beacon on the same host            │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────┴───────────────────────────┐
│                 drone-beacon                       │
│  (local sync: system-wide skills, memories, IDs)  │
│  runs on same host as agent or on LAN             │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────┴───────────────────────────┐
│                 drone-agent                        │
│  (CLI: LLM, tools, MCP client, plugins)           │
│  runs anywhere                                     │
└──────────────────────────────────────────────────┘
```

### Failure Mode: Graceful Degradation

Each level works without the one above it:

- **Offline:** Agent works with `.drone/` files at project scope
- **LAN:** Agents share via beacon
- **Cloud:** Cross-site coordination via coordinator

You can run `drone-agent` without the swarm plugin and just have a decent, very minimal, coding agent.

---

## Plugin Architecture

Plugins are not just MCP server wrappers. Real plugins give the agent capabilities like:

- LSP server connections (semantic code understanding)
- TODO list management
- Subagent spawning without blocking on the CLI
- Coding context window management
- Model providers

Plugins should change _how_ the agent does things, not just connect external tools. MCP connections are built-in; plugins layer behavior on top. Drawing lessons from the `alice-assistant` project — if someone's making a plugin that just wraps an MCP server, it should feel clunky.

### LSP Integration (Strategic Differentiator)

Planned first step: Check everything for errors automatically after every change, inject status into nudge prompts.

After that, query tools:

- "Find all callers of this function"
- "What does this type resolve to"
- Diagnostics feed into agent's understanding of "is this broken"

This would make drone the first coding agent treating LSP as a first-class capability, not an afterthought. Most coding agents (Claude Code, Cursor) treat "reading code" as file I/O. drone would do what an IDE LSP client does — maintain language server connections and query semantic information.

---

## Persistence Strategy

Layered, matching the architecture:

| Level       | Store                               | Notes                                                                                         |
| ----------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Project     | `.drone/` directory with JSON files | Inspectable, git-trackable, trivially debuggable. Unix philosophy.                            |
| Beacon      | SQLite                              | Structured storage for local config, cached skills, session registry, beacon-scoped event log |
| Coordinator | SQLite or Postgres                  | Postgres for multi-writer scenarios. User's choice.                                           |

Pluggable persistence considered and explicitly rejected — plugin architectures at every layer are a maintenance nightmare.

---

## Fractal Config Scopes

Config cascades with strict override:

**Project > Beacon > Swarm > System defaults**

- No deep merge. Last-write-wins per key.
- Skills are additive (union of all scopes).
- Personality/config is strict override.

**Scope files:**

- Project: `project/.drone/`
- User system: `~/.config/drone/`
- Beacon: beacon-side configuration
- Swarm: coordinator registry

**Scope discovery:** Agent walks directory tree for `.drone/` configs, asks beacon for higher-level overrides.

**Refresh:** On next LLM turn (hot-reload). Don't interrupt a multi-minute refactor to reload personality.

---

## Identity Model

- **Agent → Beacon:** Simple "connect + approve on beacon host CLI" for localhost. For network beacons, public key auth tied to approval workflow.
- **Beacon → Coordinator:** Same approval workflow for single-user. Multi-user might warrant a fourth layer.
- Each agent holds a keypair? Coordinator as CA? Trust-on-first-use with shared swarm secret? TBD.

---

## Swarm Memory Architecture

Three models considered:

1. **Event log (append-only)** — Agents write facts to shared log. Coordinator deduplicates/summarizes. Most flexible, most expensive (mini Kafka).
2. **KV store with TTL** — Structured data. `swarm:project:bar:known-bugs` → list, expires 7d. Simple, predictable.
3. **Vector store with agent-scoped namespaces** — Coordinator runs vector DB. Each agent has own namespace. Cross-query with permissions. Most powerful, most complex.

**Plan:** Event log + vector store from the start. Default agents use neither directly. A periodic agent (or user choice) reviews the event log and promotes facts to the vector store.

The same structure repeats at the beacon level — the coordinator doesn't know about beacon-scoped agents beyond seeing their sessions in the session registry.

**Inter-agent memory access:** "You don't, unless you make a plugin for it."

---

## Swarm Plugin

One of the built-in plugins. Provides:

- Connection to `drone-beacon`
- Beacon syncs system-wide skills, memories, agent identities to connected agents
- Beacon connects to `drone-coordinator`
- Coordinator maintains central repository for swarm-wide skills, agent identities, and inter-beacon agent-spawn requests

### Inter-Beacon Agent Spawning

Beacon A can ask coordinator to tell Beacon B to spawn an agent on Beacon B's subnet. This is a distributed task routing system. Current thinking:

- Spawn sysadmin drones on remote systems for maintenance
- Framework goal — other workflows built on top
- Route spawn requests to the node with the best model for the task

### Coordinator Session Registry

The coordinator _does_ track session agents in a session registry, but it's informational (for web UI display), not control. Session agents register with their local beacon, which reports persona-level activity to the coordinator. The coordinator knows "unix-beard was active" but doesn't care which specific worker carried it.

---

## First-Run Experience

1. User pulls the package, runs setup (connect LLM provider), gets dropped into `drone-agent` TUI.
2. TUI checks: are we in home directory or project directory?
   - **Project:** Ask if user wants to start working immediately, or scan the project and suggest plugins.
   - **Home:** Ask if user wants a persistent agent. If no, exit. If yes, walk through beacon/coordinator setup or connecting to existing one.

### Bootstrapping

`drone init --coordinator` starts both the coordinator and a local beacon+agent. The agent immediately gets a task: "verify your own coordinator configuration and report status." Self-dogfooding from day one.

---

## LLM / Model Strategy

- **v1:** Hardcode Ollama.
- **v2:** Model providers become a plugin. Different hosts in the swarm might have different models available for drone-agent to use.

---

## Open Questions

- **Recovery:** Does the agent `git commit` before every tool call? Default prompt says "commit if you see version control."
- **Cross-beacon file access:** Two agents on different beacons writing to the same file — probably "don't support it, use git for merge coordination." Honest about distributed systems being hard.
- **Default experience:** Ephemeral vs persistent. Persona becomes the default for `--persona` usage.
- **Identity detail:** Keypair per agent? Coordinator as CA? TOFU with shared secret?
- **Sync vs independence:** If beacon goes down, agent still works with cached state. Eventually consistent, especially inter-beacon.
- **Coordinator maintenance:** The coordinator must always have a beacon on the same host so it can spawn agents to maintain itself.
- **Hot-reload:** Skills and personality should pick up on the next LLM turn without agent restart.

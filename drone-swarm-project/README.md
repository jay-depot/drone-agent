# drone-swarm-project

A **swarm extension** (ADR 254) that owns a **kanban board**. Cards move between
columns; a per-project **automation** starts a swarm agent session when a card
crosses a chosen transition. Agents also receive injected tools, so an agent can
read the board, create cards, and move cards itself.

It is the **second reference extension** for the swarm-extension protocol, and
the **first real TSX front-end bundle** in this repository: the board UI is
authored as TypeScript JSX under `bundle/` and compiled with esbuild into
`dist/bundle/index.js`.

## What it does

1. **Registers** with the coordinator as an extension node, connecting to the
   coordinator's **web port** (`http://127.0.0.1:8080`). On a local host the
   coordinator auto-approves the caller (ADR 257).
2. **Owns the board.** Projects, columns, cards, and automations live in this
   node's `dataDir`. Every mutation — a UI drag and an agent tool call alike —
   lands on the node, so automations fire in-process.
3. **Enqueues a paced spawn** when a card move matches an automation. Every
   matching move enqueues a job; a drain loop starts jobs under two speed
   limits (`maxConcurrentSessions`, `maxDailySessions`).
4. **Injects card tools** into top-level agent sessions (unmounted — the model
   mounts them with `runtime__mount_tool`).
5. **Serves a front-end bundle** so the coordinator UI gets a `/board` route, a
   `sidebar-nav` entry, and a `settings-panel`.

## Capability tiers

The catalog (`src/capabilities.ts`) is the single source of truth for the
manifest and the handlers.

| Tier  | Capabilities                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp` | `project.list`, `board.get`, `card.get`, `card.create`, `card.update`, `card.move`                                                                              |
| `ui`  | `project.create/update/delete`, `column.list/create/update/reorder/delete`, `automation.list/create/update/delete`, `queue.list/retry/cancel`, `limits.get/set` |

`mcp`-tier capabilities are agent-callable and visible to MCP clients. `ui`-tier
capabilities are for the coordinator UI only; the coordinator rejects an agent
caller with `403 CAPABILITY_NOT_AGENT_CALLABLE`.

## Automations

An automation is a transition pair:

```json
{
  "when": { "from": "<columnId>", "to": "<columnId>" },
  "then": {
    "action": "launch-session",
    "personaId": "code",
    "model": "optional",
    "promptTemplate": "Work on {{card.title}} ({{project.name}})"
  }
}
```

`from`/`to` are column ids; `*` is a wildcard, allowed on **one side only**.
The prompt template renders `{{card.title}}`, `{{card.description}}`,
`{{column.name}}` (the destination column), and `{{project.name}}`.

Launch is **two steps**: the node POSTs `/api/spawn` with an `extensionHint` of
`drone-swarm-project:card:<cardId>`; when the matching `sessionStarted` snapshot
arrives it POSTs the rendered prompt to `/api/sessions/:id/message`.

The automation **inherits** the project's `defaultBeaconId` and
`defaultWorkingDir`. A per-automation override is **reserved** for a later
version.

## Queue and limits

- `maxConcurrentSessions` (default `1`) and `maxDailySessions` (default `12`)
  constrain the **speed** of spawns, not the actor. Every move is recorded with
  an `actor` (`user`/`agent`) for audit and display; the actor gates nothing.
- Every matching move **enqueues a job**. Enqueue always succeeds; the queue may
  hold more jobs than `maxDailySessions`.
- A drain loop starts jobs under three gates: concurrency, the rolling-24h
  daily cap, and spacing (`24h / maxDailySessions`, 2h by default).
- Job states: `queued → running → done | failed | cancelled`. Start timestamps
  are persisted; the 24h window is derived on read, so a restart keeps the pace.
- On session end **nothing moves automatically**. The job closes and the card
  keeps its `sessionId`/`spawnId` as history; the agent moves the card itself.

## Store layout

Data lives under `dataDir` (default `~/.drone-agent/drone-swarm-project`):

| Path                        | Contents                                   |
| --------------------------- | ------------------------------------------ |
| `index.json`                | Project index (`{ version, projects[] }`). |
| `projects/<projectId>.json` | One project (columns, cards, automations). |
| `queue.json`                | Limits plus the job queue.                 |

All access goes through the `BoardStore` and `SchedulerStore` interfaces, so a
future SQLite implementation can replace the JSON one.

## Usage

```bash
# Start the coordinator + a beacon, then:
pnpm --filter drone-swarm-project run build
node drone-swarm-project/bin/drone-swarm-project
```

### Environment

| Variable                              | Default                              | Purpose                    |
| ------------------------------------- | ------------------------------------ | -------------------------- |
| `DRONE_SWARM_PROJECT_COORDINATOR_URL` | `http://127.0.0.1:8080`              | Coordinator to connect to. |
| `DRONE_SWARM_PROJECT_DATA_DIR`        | `~/.drone-agent/drone-swarm-project` | Board, queue, identity.    |
| `DRONE_SWARM_PROJECT_ID`              | `drone-swarm-project`                | Node id.                   |
| `DRONE_SWARM_PROJECT_INJECT_TOOLS`    | `true`                               | Inject card tools.         |
| `DRONE_SWARM_PROJECT_MAX_CONCURRENT`  | `1`                                  | Concurrent session limit.  |
| `DRONE_SWARM_PROJECT_MAX_DAILY`       | `12`                                 | Rolling-24h session limit. |

`--pre-approval-token-path` (both `=` and space forms) performs a one-shot
registration against a remote coordinator and exits, mirroring `mcp-swarm`.

## Docker

Docker images are **deferred** for this version, following the `mcp-swarm` and
`drone-swarm` precedent. The package's integration tests therefore do not run in
`pnpm test:integration`.

## Layout

| File                         | Purpose                                                |
| ---------------------------- | ------------------------------------------------------ |
| `src/board-types.ts`         | Domain types (Project, Column, Card, Automation, Job). |
| `src/ids.ts`                 | Id helpers (`p_`, `c_`, `a_`, `j_`, `col_`).           |
| `src/store/*.ts`             | Store interfaces + the JSON implementation.            |
| `src/automations.ts`         | Transition matching and prompt rendering.              |
| `src/scheduler.ts`           | The paced drain loop.                                  |
| `src/scheduler-reconcile.ts` | Boot reconcile after a restart.                        |
| `src/spawn.ts`               | Coordinator spawn + message calls.                     |
| `src/session-events.ts`      | Session lifecycle handlers and injection.              |
| `src/capabilities.ts`        | The capability catalog.                                |
| `src/handlers.ts`            | Action/tool dispatch.                                  |
| `bundle/`                    | The TSX front-end (built by esbuild).                  |
| `src/index.ts`               | Wires the node, store, scheduler, and bundle.          |
| `bin/drone-swarm-project`    | Executable shim.                                       |

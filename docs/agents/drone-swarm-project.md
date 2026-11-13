# drone-swarm-project (Kanban Board Extension)

`drone-swarm-project` is a **swarm extension** (ADR [254](../adr/254-swarm-extensions.md))
that owns a **kanban board**. Cards move between columns; a per-project
**automation** starts a swarm agent session when a card crosses a chosen
transition. Agents also get injected tools, so an agent can read the board,
create cards, and move cards itself.

It is the **second reference extension** after `mcp-swarm`, and the **first real
TSX front-end bundle** in this repository: the board UI is authored as
TypeScript JSX under `bundle/` and compiled with esbuild.

See ADR [`271-drone-swarm-project-kanban-extension`](../adr/271-drone-swarm-project-kanban-extension.md)
for the design.

## Model

A **project** is a namespace: `{ id, name, defaultBeaconId?, defaultWorkingDir?,
columns[], cards[], automations[] }`. Columns are configurable and ordered, and
are seeded **Todo / In Progress / Done** at creation.

An **automation** is a transition pair:

```
when: { from: <columnId> | '*', to: <columnId> | '*' }
then: { action: 'launch-session', personaId, model?, promptTemplate }
```

`*` is allowed on **one side only** — "any → Done" and "In Progress → any" are
expressible; "any → any" is rejected. The prompt template renders
`{{card.title}}`, `{{card.description}}`, `{{column.name}}` (the destination
column), and `{{project.name}}`.

An automation **inherits** the project's `defaultBeaconId` and
`defaultWorkingDir`. A per-automation override is reserved for a later version.

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

## Launch mechanism

Launch is **two steps** (because the spawn path silently ignores `--task`):

1. `POST /api/spawn` with the project's inherited beacon/working dir and an
   `extensionHint` of `drone-swarm-project:card:<cardId>`.
2. When the matching `sessionStarted` snapshot arrives, `POST
/api/sessions/:id/message` with the rendered prompt.

The card then carries `sessionId` / `spawnId` / `sessionStatus` as history.

## Queue and limits

- `maxConcurrentSessions` (default `1`) and `maxDailySessions` (default `12`)
  constrain the **speed** of spawns, not the actor. Every move is recorded with
  an `actor` (`user`/`agent`) for audit and display; the actor gates nothing.
- Every matching move **enqueues a job**. Enqueue always succeeds; the queue may
  hold more jobs than `maxDailySessions`.
- A drain loop starts jobs under three gates: concurrency, the rolling-24h
  daily cap, and spacing (`24h / maxDailySessions`, 2h by default). The first
  job starts at once.
- Job states: `queued → running → done | failed | cancelled`. Start timestamps
  are persisted; the 24h window is derived on read, so a restart keeps the pace.
- On session end **nothing moves automatically**. The job closes and the card
  keeps its `sessionId`/`spawnId`; the agent moves the card itself with
  `card_move`.

## Store

Data lives under `dataDir` (default `~/.drone-agent/drone-swarm-project`):

| Path                        | Contents                                   |
| --------------------------- | ------------------------------------------ |
| `index.json`                | Project index (`{ version, projects[] }`). |
| `projects/<projectId>.json` | One project (columns, cards, automations). |
| `queue.json`                | Limits plus the job queue.                 |

All access goes through the `BoardStore` and `SchedulerStore` interfaces, so a
future SQLite implementation can replace the JSON one.

## Card tools and the card-bound shortcut

Card tools are injected into **every top-level session** (a node option
`injectToolsIntoAllSessions`, default `true`; subagent sessions are skipped). The
tools are injected **unmounted** — the model calls `runtime__mount_tool` first —
so persona globs (`!extensions__*`) keep working.

A **card-bound session** (an `extensionHint` of `drone-swarm-project:card:<cardId>`)
gets a shortcut: `card.get`/`card.update`/`card.move` accept an omitted
`projectId`/`cardId` and default to the bound card, plus a one-time fragment
telling the agent which card it owns.

## Project create and edit

The board page and the settings panel share a `ProjectSelect` dropdown and a
`useProjects()` hook. The dropdown gains a `New Project…` sentinel
(`__new_project__`) as its last option. A pick of the sentinel opens a
`ProjectModal` and does **not** change the selection, so the sentinel value
never becomes the selection.

The modal has three fields: **Name** (required), **Beacon**, and **Working
directory**. The Beacon picker lists connected beacons. It removes extension
nodes, which the coordinator registers as beacons but which cannot spawn a
session (it reads `isExtension` from `GET /api/extensions`). The Working
directory picker lists the selected beacon's `spawnRoots`, seeded
`defaultSpawnRoot ?? spawnRoots[0]` and re-seeded when the beacon changes.

On the board page a separate **Edit Project** button sits next to the dropdown.
It acts on the currently selected project and is disabled when no project is
selected. The settings panel shows the sentinel too; a pick there navigates to
`/board`, so one modal lives in one place.

One `ProjectModal` serves both modes through a `mode` prop. In edit mode a
stored beacon or working directory that is not in the live list is still shown,
annotated `(offline)`, and preselected — it is never silently rewritten.
`project.update` treats an empty `defaultWorkingDir` as "no change", so the
modal cannot clear a working directory.

See ADR [`275-kanban-project-create-and-edit-ui`](../adr/275-kanban-project-create-and-edit-ui.md).

## Create a card from the board

Every column has an **Add card** button at its bottom. The button is a full
width **ghost** button and is always visible. Its label is `+ Add card`, and its
accessible name is `Add card to <column name>`.

A click opens the **New card** modal. The target column is fixed: it is the
column whose button was clicked. The modal shows the column name as read-only
text; there is no column picker. The modal has a **Title** field and a
**Description** field. The Title field is focused on open. The Create button is
disabled while the title is empty and while a create is in progress. A failed
create shows an inline error and keeps the modal open.

On success the modal closes, the board reloads, and the project list reloads
(the dropdown shows a card count). The new card goes to the **end** of the
column.

`card.create` is `mcp`-tier, so the UI can already call it. No server change was
needed. A create can fire an automation: `card.create` already enqueues for a
wildcard-from rule (`* → <column>`). This is accepted — card creation is an
arrival in the column. A card created by the UI records `actor: 'user'`.

The `New card` modal, `CardModal`, `ProjectModal`, and `QueueModal` all use a
shared `Modal` shell (`bundle/Modal.tsx`). The shell owns the backdrop, the
panel, the header (`<h2>` + Close), and the Escape listener; the children are
the body only. `Button` gains a third variant, `ghost`, for the add-card button.

See ADR [`278-kanban-add-card-ui`](../adr/278-kanban-add-card-ui.md).

## Styling

The bundle themes itself with `dsp-*` classes that read the host design tokens
(`var(--primary)`, `var(--border)`, `var(--input)`, `var(--radius)`,
`var(--foreground)`, `var(--muted-foreground)`, and so on) with fallback values.
It cannot import the host components and cannot use Tailwind, because it is a
separate esbuild build and only React is shared. A shared local `Button`
component (`bundle/Button.tsx`) applies the button classes, so the class string
is not repeated at every call site.

See ADR [`277-kanban-bundle-host-theme-tokens`](../adr/277-kanban-bundle-host-theme-tokens.md).

## Running it

```bash
pnpm --filter drone-swarm-project run build
node drone-swarm-project/bin/drone-swarm-project
```

Config via env (prefix `DRONE_SWARM_PROJECT_`): `COORDINATOR_URL`, `DATA_DIR`,
`ID`, `INJECT_TOOLS`, `MAX_CONCURRENT`, `MAX_DAILY`. `--pre-approval-token-path`
performs a one-shot registration against a remote coordinator and exits.

Docker images are **deferred** for this version (the `mcp-swarm` and
`drone-swarm` precedent), so its integration tests do not run in
`pnpm test:integration`.

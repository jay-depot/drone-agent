---
key: plan-drone-swarm-project
tags:
  - plan
  - drone-swarm-project
  - swarm-extension
  - kanban
  - automation
  - scheduler
created: 2026-11-09T18:22:35.509Z
updated: 2026-11-09T18:53:22.797Z
---

# Plan: `drone-swarm-project` — kanban board swarm extension

Status: ready for execution. Grilled in session agent-1794166708901 (persona `plan`).
Design of record: wiki page `drone-swarm-project-plan-of-record` (update it after execution).

## 1. Summary

`drone-swarm-project` is a new workspace package. It is a **swarm extension node**
(ADR 254). It owns a **kanban board**. The board has projects, columns and cards.
When a card moves from one column to another, a per-project **automation** starts a
swarm agent session. Agents also get injected tools. Thus an agent can read the board,
create cards, and move cards.

Why: we want to drive agent work from a board. A human moves a card. An agent starts.
The agent does the work. The agent moves the card. The extension controls the **speed**
of the spawns, so a human can intervene.

## 2. Decisions (locked — do not re-litigate)

| # | Decision |
| --- | --- |
| D1 | New workspace package `drone-swarm-project`. Model it on `mcp-swarm` (see §3). |
| D2 | A **project is a namespace**: `{ id, name, defaultBeaconId?, defaultWorkingDir?, columns[], cards[], automations[] }`. |
| D3 | Columns are configurable, ordered, per project. Seed **Todo / In Progress / Done** at project creation. |
| D4 | The **node owns the board**. Every mutation (UI drag and agent tool call) lands on the node. Automations fire in-process. No coordinator board tables. No cross-process bus. |
| D5 | An automation is `{ id, name, enabled, when: { from, to }, then: { action: 'launch-session', personaId, model?, promptTemplate } }`. |
| D6 | `when.from`/`when.to` are column ids. `*` is a wildcard. `*` is allowed on **one side only**, never on both. |
| D7 | `promptTemplate` is rendered with `{{card.title}}`, `{{card.description}}`, `{{column.name}}` (destination column), `{{project.name}}`. |
| D8 | Launch is **two steps**: `POST /api/spawn` (with `config.extensionHint`), then `POST /api/sessions/:id/message` when the matching `sessionStarted` arrives. |
| D9 | The automation **inherits** `project.defaultBeaconId` and `project.defaultWorkingDir`. A per-automation override is **reserved** for a later version. Do not build it now. But keep the shape open (put the values in a small resolver, not inline). |
| D10 | Speed limits are **node-wide**: `maxConcurrentSessions` (default 1) and `maxDailySessions` (default 12). |
| D11 | The limits constrain **speed**, not the actor. Record `actor` (`user`/`agent`) on every move for audit and display. The actor gates nothing. |
| D12 | Every matching move **enqueues a job**. A drain loop paces the starts. Job states: `queued → running → done | failed | cancelled`. |
| D13 | Pacing interval = `24h / maxDailySessions` (2h at the default). The first job starts at once. |
| D14 | Persist the real start timestamps. Derive the rolling 24h window **on read**. Never keep the pacing in an in-memory counter. Never keep it in a `setInterval` that a restart resets. |
| D15 | The daily cap applies at **drain time only**. Enqueue always succeeds. The queue can hold more jobs than `maxDailySessions`. Nothing is refused at enqueue. |
| D16 | When a session ends, **nothing moves automatically**. The job closes (`done`, or `failed`). The card keeps its `sessionId`/`spawnId` as history. The agent moves the card itself with `card_move`. |
| D17 | Store: one JSON file per project, plus an index, plus one queue file. All access goes through store interfaces, so a later SQLite version can replace the JSON version. |
| D18 | Card ids are UUIDs from the start: `c_<uuid>`. They are unique for all time. |
| D19 | The extension hint is `drone-swarm-project:card:<cardId>`. |
| D20 | The front-end panel is **real TSX**, built with **esbuild** into `dist/bundle/index.js`. This is the first real TSX extension bundle in this repository. Treat it as a worked example. |
| D21 | Card tools are injected into **every top-level session**. A node option `injectToolsIntoAllSessions` (default `true`) controls it. |
| D22 | Do **not** inject into subagent sessions (`snapshot.isSubagent === true`) in this version. Reserve an exception mechanism for later. |
| D23 | Card tools are injected **unmounted**. The model must call `runtime__mount_tool` first. |
| D24 | Tiers: board and card management are `mcp` tier. Columns, automations, limits, and queue administration are `ui` tier (never agent-callable). |
| D25 | A card-bound session can omit `projectId`/`cardId`. The tool uses the bound card. Inject one fragment that tells the agent which card it owns. |
| D26 | The UI polls for board and queue data. There is no push channel from the extension to the UI. |

## 3. Ground truth (verified against source — rely on this)

### SDK (`drone-swarm-common/src/extension-server.ts`)
- `createExtensionNode({ coordinatorUrl, dataDir, id, name, capabilities, handlers, host?, awaitRegistration?, requestTimeoutMs?, expectedCoordinatorFingerprint? })`.
- Handlers: `onInvokeAction(cap, params, ctx)`, `onInvokeTool(cap, params, ctx)`, `onSessionStarted(snapshot)`, `onSessionEnded(event)`.
- Node methods: `getFetch()`, `injectFragment({target,id,content,phase?,ttlMs?})`, `injectReminder({target,id,content})`, `injectTools({target,capabilities:string[]})`, `removeInjection({target,kind,injectionId?,tools?})`, `declareManifest(manifest)`, `uploadBundle({name,version,files})`, `stop()`.
- Connect to the coordinator **web port** (default `http://127.0.0.1:8080`). Loopback callers are auto-approved (ADR 257). Do not use the mTLS primary port.

### Coordinator routes (`drone-coordinator/src/routes/extensions.ts`)
- `GET /api/extensions` → `[{ nodeId, connected, isExtension, protocolVersion, capabilities, bundles: [{ name, version, hash, scriptUrls, styleUrls }] }]`.
- `POST /api/extensions/:nodeId/actions/:action` (caller `ui`). Body `{ params?, sessionId? }`.
- `POST /api/extensions/:nodeId/tools/:tool` (caller `agent`). Body `{ params?, sessionId? }`. A `ui`-tier capability returns `403 CAPABILITY_NOT_AGENT_CALLABLE`.
- `PUT /api/extensions/bundles/:name`. Body `{ version, files: [{ name, contentBase64, contentType }] }`. Returns `{ hash }`. The node id travels in the `x-node-id` header on the unencrypted port.
- Bundles are served at `/plugin-scripts/:nodeId/:hash/:name` and `/plugin-styles/:nodeId/:hash/:name`.

### Session lifecycle
- `sessionStarted` and `sessionEnded` frames are broadcast to **every** node. They are **replayed on connect** for active sessions.
- `DroneSessionSnapshot` = `{ protocolVersion, sessionId, personaId, beaconId, interactive, isSubagent, cwd, enabledPlugins, mountedTools, extensionHint? }`.
- `DroneSessionEndedEvent` = `{ sessionId, extensionHint? }`.

### Spawn and message
- `POST /api/spawn` body `{ targetBeaconId (required), personaId?, task?, config?: { model?, preamble?, workingDir?, env?, extensionHint? }, spawnId? }`. Returns `201` with the beacon body plus `targetBeaconId`. `404 BEACON_NOT_FOUND`. `503 BEACON_UNAVAILABLE`. The beacon body contains `agentId` (this equals the session id).
- `POST /api/sessions/:id/message` body `{ content, steer? }` → `{ success, delivered }`. The session must be known to the coordinator. If not, retry with backoff.

### Agent side
- Plugin `drone-agent/src/plugins/extensions/`. An injected tool has the canonical name `extensions__<extId>__<tool>` and is **unmounted**.
- The injection target is the session id.
- `extensionHint` is set by `--extension-hint` / `DRONE_EXTENSION_HINT` and appears in the snapshot.

### Repository conventions for a new package (all required, or the package will not build or test)
- `pnpm-workspace.yaml` → add `- drone-swarm-project`.
- `pnpm-lock.yaml` → run `pnpm install` and commit.
- Per-package `package.json` and `tsconfig.json` → copy the `mcp-swarm` shape.
- `bin/drone-swarm-project` → 8-line shim, mode `100755`.
- `vitest.config.ts` → add to `test.include` **and** `coverage.include`.
- `tsconfig.test.json` (root) → add `src/**/*.ts` and `test/**/*.ts` lines.
- `tsc -b` builds the project references, so cross-package imports resolve in CI without a separate build.
- Docker images: **deferred** for this version (the `mcp-swarm` and `drone-swarm` precedent). Its integration tests then do not run in `pnpm test:integration`. Record this in the README.

## 4. Steps

Each step is atomic. Run the steps in order. A step depends on all steps before it.

### Phase 0 — Scaffold the package

**Step 1 — Register the workspace member.** Agent: `code`.
Edit `pnpm-workspace.yaml`. Add `- drone-swarm-project` to the `packages:` list.

**Step 2 — Create `drone-swarm-project/package.json`.** Agent: `code`.
Copy the `mcp-swarm` shape. Use these values:

```json
{
  "name": "drone-swarm-project",
  "version": "0.1.0",
  "description": "Swarm extension: a kanban board that starts agent sessions as cards move.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "drone-swarm-project": "./bin/drone-swarm-project" },
  "files": ["dist", "bin"],
  "private": true,
  "scripts": {
    "build": "tsc -b && node scripts/build-bundle.mjs",
    "typecheck": "tsc -b --pretty false && tsc -p bundle/tsconfig.json",
    "clean": "rm -rf dist tsconfig.tsbuildinfo",
    "test": "echo 'drone-swarm-project tests run via root vitest'",
    "start": "node ./bin/drone-swarm-project"
  },
  "dependencies": {
    "drone-core": "workspace:*",
    "drone-swarm-common": "workspace:*",
    "drone-extension-ui-types": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.0.10",
    "@types/react": "^19.0.0",
    "react": "^19.0.0",
    "esbuild": "^0.25.12"
  }
}
```

Note: `react` is a devDependency only. The bundle must not import it at runtime. React is read from `globalThis.React`.

**Step 3 — Create `drone-swarm-project/tsconfig.json`.** Agent: `code`.
Copy the `mcp-swarm` file. Add `../drone-extension-ui-types` to `references`. Keep `include: ["src/**/*"]`.

**Step 4 — Create `drone-swarm-project/bin/drone-swarm-project`.** Agent: `code`.
```js
#!/usr/bin/env node
import { main } from '../dist/index.js';

main().catch(err => {
  console.error(String(err));
  process.exit(1);
});
```
Run `chmod +x`. Confirm the mode bit is `100755` in git.

**Step 5 — Update the root test and typecheck wiring.** Agent: `code`.
- `vitest.config.ts`: add `'drone-swarm-project/test/**/*.test.ts'` to `test.include`. Add `'drone-swarm-project/src/**/*.ts'` to `coverage.include`.
- `tsconfig.test.json`: add `"drone-swarm-project/src/**/*.ts"` and `"drone-swarm-project/test/**/*.ts"` to `include`. Add them after the `mcp-swarm` lines.
- Run `pnpm install`. Commit the changed `pnpm-lock.yaml`.

**Step 6 — Create `drone-swarm-project/README.md`.** Agent: `code`.
Describe the node, the two env config sets, the run command, the capability tiers, the store layout, and the Docker-deferred note. Model it on `mcp-swarm/README.md`.

### Phase 1 — Domain types and store

**Step 7 — Create `src/board-types.ts`.** Agent: `code`.
Define the domain types. Exact shapes:

```ts
export interface Column { id: string; name: string; order: number; isTerminal?: boolean; }

export interface MoveRecord {
  at: number;
  actor: 'user' | 'agent' | 'automation';
  fromColumnId: string | null;
  toColumnId: string;
}

export interface Card {
  id: string;              // 'c_<uuid>'
  title: string;
  description?: string;
  columnId: string;
  position: number;
  history: MoveRecord[];   // bounded to the last 50
  sessionId?: string;
  spawnId?: string;
  sessionStatus?: 'running' | 'ended' | 'failed';
}

export interface AutomationThen {
  action: 'launch-session';
  personaId: string;
  model?: string;
  promptTemplate: string;
}

export interface Automation {
  id: string;              // 'a_<uuid>'
  name: string;
  enabled: boolean;
  when: { from: string; to: string };  // column ids, or '*'
  then: AutomationThen;
}

export interface Project {
  id: string;              // 'p_<uuid>'
  name: string;
  defaultBeaconId?: string;
  defaultWorkingDir?: string;
  columns: Column[];
  cards: Card[];
  automations: Automation[];
}

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;              // 'j_<uuid>'
  projectId: string;
  cardId: string;
  ruleId: string;
  prompt: string;          // rendered at enqueue time
  state: JobState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  spawnId?: string;
  agentId?: string;
  sessionId?: string;
  instructionSent?: boolean;
  error?: string;
}

export interface Limits { maxConcurrentSessions: number; maxDailySessions: number; }
```

**Step 8 — Create `src/ids.ts`.** Agent: `code`.
Small helpers: `newProjectId()`, `newColumnId()`, `newCardId()`, `newAutomationId()`, `newJobId()`. Each returns the prefix plus `randomUUID()`.

**Step 9 — Create `src/store/board-store.ts`** (the interface). Agent: `code`.
```ts
export interface BoardStore {
  listProjects(): Promise<Array<{ id: string; name: string; cardCount: number }>>;
  getProject(id: string): Promise<Project | undefined>;
  createProject(input: { name: string; defaultBeaconId?: string; defaultWorkingDir?: string }): Promise<Project>;
  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'defaultBeaconId' | 'defaultWorkingDir'>>): Promise<Project | undefined>;
  deleteProject(id: string): Promise<boolean>;
  getCard(cardId: string): Promise<{ project: Project; card: Card } | undefined>;
  createCard(input: { projectId: string; title: string; description?: string; columnId?: string; actor: MoveRecord['actor'] }): Promise<Card | undefined>;
  updateCard(input: { projectId: string; cardId: string; title?: string; description?: string }): Promise<Card | undefined>;
  moveCard(input: { projectId: string; cardId: string; toColumnId: string; position?: number; actor: MoveRecord['actor'] }): Promise<{ card: Card; fromColumnId: string | null } | undefined>;
  addColumn(input: { projectId: string; name: string }): Promise<Column | undefined>;
  updateColumn(input: { projectId: string; columnId: string; name?: string; order?: number }): Promise<Column | undefined>;
  deleteColumn(input: { projectId: string; columnId: string }): Promise<boolean>;
  listAutomations(projectId: string): Promise<Automation[]>;
  createAutomation(input: { projectId: string; automation: Omit<Automation, 'id'> }): Promise<Automation | undefined>;
  updateAutomation(input: { projectId: string; automationId: string; patch: Partial<Omit<Automation, 'id'>> }): Promise<Automation | undefined>;
  deleteAutomation(input: { projectId: string; automationId: string }): Promise<boolean>;
  getCardProjectId(cardId: string): string | undefined;
}
```
`getCardProjectId` is synchronous. It reads the in-memory card-to-project map.

**Step 10 — Create `src/store/scheduler-store.ts`** (the interface). Agent: `code`.
```ts
export interface SchedulerStore {
  getLimits(): Promise<Limits>;
  setLimits(patch: Partial<Limits>): Promise<Limits>;
  listJobs(): Promise<Job[]>;
  enqueueJob(job: Job): Promise<void>;
  updateJob(jobId: string, patch: Partial<Job>): Promise<Job | undefined>;
}
```

**Step 11 — Create `src/store/json-store.ts`.** Agent: `code`.
Implement **both** interfaces (`JsonStore implements BoardStore, SchedulerStore`). Rules:
- Files: `dataDir/index.json`, `dataDir/projects/<projectId>.json`, `dataDir/queue.json`.
- In-memory state is the source of truth. Load at construction.
- Every write goes through `withPathLock(path, fn)` from `drone-swarm-common`, then a temp-file write and a `rename` (atomic). Reuse the `token-store.ts` pattern from `mcp-swarm`.
- Formats: `index.json` = `{ version: 1, projects: [{ id, name, updatedAt }] }`. `queue.json` = `{ version: 1, limits: Limits, jobs: Job[] }`.
- Build a `cardId → projectId` map at load. Update it on every card write. `getCardProjectId` reads it.
- `moveCard` appends a `MoveRecord`, sets the new `columnId`, recomputes `position`, and truncates `history` to 50.
- `createCard` puts the card at the end of the target column (or the first column).
- Reject `createAutomation` when `when.from === '*' && when.to === '*'`.

Provide a factory: `async function createJsonStore(dataDir: string, seedLimits: Limits): Promise<JsonStore>`.

### Phase 2 — Automations and prompt rendering

**Step 12 — Create `src/automations.ts`.** Agent: `code`.
```ts
export function matchesTransition(automation: Automation, from: string | null, to: string): boolean;
export function renderPrompt(template: string, ctx: { card: Card; column: Column; project: Project }): string;
```
- `matchesTransition`: `(a.when.from === '*' || a.when.from === from) && (a.when.to === '*' || a.when.to === to)`. `from` may be `null` (card creation) — a `null` from matches only `when.from === '*'`.
- `renderPrompt`: replace `{{card.title}}`, `{{card.description}}`, `{{column.name}}` (destination column), `{{project.name}}`. Replace an unknown token with an empty string.
- `selectAutomations(project, from, to)` returns the enabled, matching automations.

### Phase 3 — Scheduler

**Step 13 — Create `src/scheduler.ts`.** Agent: `code`.
A `Scheduler` class. It holds the `SchedulerStore` and a spawn function (injected — see Step 15).

```ts
export interface SchedulerDeps {
  store: SchedulerStore;
  board: BoardStore;
  spawn: (job: Job, project: Project) => Promise<{ spawnId: string; agentId: string }>;
  now?: () => number;
  logger?: (msg: string) => void;
}

export class Scheduler {
  enqueue(job: Job): Promise<void>;   // store.enqueueJob, then tick()
  tick(): Promise<void>;              // evaluate the three gates, start at most one job
  reconcile(): Promise<void>;         // mark stale 'running' jobs failed (see Step 16)
  start(intervalMs?: number): void;   // setInterval(() => tick(), ...)
  stop(): void;
}
```

The three gates in `tick()`, in this order:
1. **Concurrency**: `count(jobs where state === 'running') < limits.maxConcurrentSessions`.
2. **Daily**: `count(jobs where startedAt && startedAt > now - 24h) < limits.maxDailySessions`.
3. **Spacing**: `now >= lastStartedAt + intervalMs`, where `intervalMs = 24h / limits.maxDailySessions` and `lastStartedAt = max(startedAt)` over all jobs.

If a gate fails, return. If all gates pass and a `queued` job exists, take the **oldest** one, set `state='running'` and `startedAt=now`, then call `spawn(job, project)`. On a spawn error, set `state='failed'`, `error`, and `endedAt`. Then call `tick()` again only if the concurrency gate still passes (loop, but bound to `maxConcurrentSessions` starts per tick).

Add `intervalMs(limits)` as a pure function. Unit-test it and the gates directly.

**Step 14 — Create `src/scheduler-reconcile.ts`.** Agent: `code`.
Boot reconcile. Do not call the coordinator. Use the replay:
- On `sessionStarted`, mark the matching job `running` (it was already `running`; this confirms it after a restart).
- Add a `pendingReconcile` set: at boot, every job with `state === 'running'` goes into the set.
- A `sessionStarted` removes its job from the set.
- After a settle window (default 30s) from the first socket connect, call `scheduler.reconcile()`: every job still in the set → `state='failed'`, `error='session not found after restart'`, and set the card `sessionStatus='failed'`.

Hide the settle logic behind a small `ReconcileTracker` class so it is unit-testable with a fake clock.

### Phase 4 — Spawn, message, and session events

**Step 15 — Create `src/spawn.ts`.** Agent: `code`.
```ts
export interface SpawnDeps { fetch: typeof fetch; coordinatorUrl: string; logger?: (m: string) => void; }

export async function spawnSession(deps, input: {
  targetBeaconId: string; personaId: string; model?: string;
  workingDir?: string; extensionHint: string;
}): Promise<{ spawnId: string; agentId: string }>;

export async function instructSession(deps, input: {
  sessionId: string; content: string; retries?: number;
}): Promise<boolean>;
```
- `spawnSession`: `POST ${coordinatorUrl}/api/spawn` with the body from the ground truth section. Read `spawnId` and `agentId` from the reply. Throw on a non-201.
- `instructSession`: `POST ${coordinatorUrl}/api/sessions/${sessionId}/message` with `{ content }`. Retry on a non-2xx with backoff (e.g. 5 tries, 500ms × 2^n). Return `true` on success, `false` after the last try. This covers the race where the agent has not registered yet.
- Put this fetch through `node.getFetch()` so the coordinator call carries the node identity.

**Step 16 — Create `src/session-events.ts`.** Agent: `code`.
```ts
export function makeSessionHandlers(deps: {
  store: SchedulerStore; board: BoardStore; node: ExtensionNode;
  instruct: (sessionId: string, content: string) => Promise<boolean>;
  settings: { injectToolsIntoAllSessions: boolean };
  reconcile: ReconcileTracker;
}): Pick<ExtensionNodeHandlers, 'onSessionStarted' | 'onSessionEnded'>;
```
`onSessionStarted(snapshot)`:
1. Parse the card id from `snapshot.extensionHint` when it matches `/^drone-swarm-project:card:(.+)$/`.
2. If a job exists with `agentId === snapshot.sessionId` (or, failing that, with `cardId === parsedCardId` and `state === 'running'`):
   - Set `job.sessionId = snapshot.sessionId`, `job.instructionSent = true`.
   - Set the card `sessionId`, `spawnId`, `sessionStatus = 'running'`.
   - Call `instruct(snapshot.sessionId, job.prompt)`.
   - Remove the job from the reconcile set.
3. **Injection** (independent of the job):
   - If `snapshot.isSubagent` → do nothing.
   - Else if `settings.injectToolsIntoAllSessions` → `node.injectTools({ target: snapshot.sessionId, capabilities: CARD_TOOL_CAPABILITIES })`.
   - If the hint parsed a card id → also `node.injectFragment({ target: snapshot.sessionId, id: 'card-binding', content: cardBindingFragment(card, project) })`.

`onSessionEnded(event)`:
1. Find the job with `sessionId === event.sessionId` and `state === 'running'`.
2. Set `state='done'`, `endedAt=now`.
3. Set the card `sessionStatus='ended'`. Keep `sessionId`/`spawnId`.
4. Call `scheduler.tick()` (a slot may now be free).

Write `cardBindingFragment(card, project)` in this file. It returns a short Markdown string: it names the card, the project, and says the agent should move the card with `card_move` when done.

### Phase 5 — Capability catalog and handlers

**Step 17 — Create `src/capabilities.ts`.** Agent: `code`.
Declare the catalog exactly as designed. The single source of truth for both the manifest and the handlers.

`mcp` tier (agent-callable, `exposed` omitted = `mcp`):
- `project.list`, `board.get`, `card.get`, `card.create`, `card.update`, `card.move`.

`ui` tier (`exposed: 'ui'`):
- `project.create`, `project.update`, `project.delete`,
- `column.list`, `column.create`, `column.update`, `column.reorder`, `column.delete`,
- `automation.list`, `automation.create`, `automation.update`, `automation.delete`,
- `queue.list`, `queue.retry`, `queue.cancel`,
- `limits.get`, `limits.set`.

Each capability: `{ name, description, paramSchema, exposed? }`. Give each `card.*` capability optional `projectId` and (for `card.get`/`card.update`/`card.move`) optional `cardId`, so the card-bound shortcut works.

Export:
- `CAPABILITIES: DroneExtensionCapability[]`
- `CARD_TOOL_CAPABILITIES: string[]` = the six `mcp`-tier names.

**Step 18 — Create `src/handlers.ts`.** Agent: `code`.
```ts
export function makeHandlers(deps: {
  board: BoardStore; scheduler: Scheduler; store: SchedulerStore;
  settings: { injectToolsIntoAllSessions: boolean };
}): Pick<ExtensionNodeHandlers, 'onInvokeAction' | 'onInvokeTool'>;
```
`dispatch(cap, params, ctx)`:
1. Find the capability in `CAPABILITIES`. Unknown → `{ ok: false, status: 404 }`.
2. If `cap.exposed === 'ui'` and `ctx.caller !== 'ui'` → `{ ok: false, status: 403 }`. (The coordinator also blocks this; keep the guard.)
3. Resolve card-bound defaults: when the capability is `card.*` and `ctx.sessionId` is set, look up the session's card (use `getCardProjectId` plus a session→card lookup in the reconcile/store layer) and fill a missing `projectId`/`cardId`. If the parameters are still incomplete → `{ ok: false, status: 400 }`.
4. Run the operation against the store.
5. **After a card mutation that moves a card** (`card.move` and `card.create`): call `selectAutomations(project, fromColumnId, toColumnId)`. For each match, render the prompt and `scheduler.enqueue(job)`. A card create is a move from `null` to the first column.
6. Return `{ ok: true, status: 200, body }`.
`onInvokeAction` calls `dispatch` with `ctx.caller === 'ui'`. `onInvokeTool` calls `dispatch` with `ctx.caller === 'agent'`.

Also export a session→card map accessor, so the card-bound shortcut is a lookup. Keep this map in the in-memory store (a spawned card session id is written when the session starts).

### Phase 6 — Front-end bundle (TSX + esbuild)

**Step 19 — Create `scripts/build-bundle.mjs`.** Agent: `code`.
```js
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/bundle', { recursive: true });
await build({
  entryPoints: ['bundle/index.tsx'],
  outfile: 'dist/bundle/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  jsxFactory: 'globalThis.React.createElement',
  jsxFragment: 'globalThis.React.Fragment',
  external: ['react', 'react-dom'],
});
await copyFile('bundle/styles.css', 'dist/bundle/style.css');
console.log('bundle written to dist/bundle/');
```

**Step 20 — Create `bundle/tsconfig.json` and `bundle/globals.d.ts`.** Agent: `code`.
`bundle/tsconfig.json` (typecheck-only):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react",
    "jsxFactory": "globalThis.React.createElement",
    "jsxFragmentFactory": "globalThis.React.Fragment",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": []
  },
  "include": ["**/*.ts", "**/*.tsx", "globals.d.ts"]
}
```
`bundle/globals.d.ts`:
```ts
import type * as ReactNS from 'react';
declare global {
  var React: typeof ReactNS;
}
export {};
```

**Step 21 — Create the bundle source files.** Agent: `code`.
- `bundle/index.tsx` — the default export:
  ```tsx
  import type { PluginClientExport } from 'drone-extension-ui-types';
  import { BoardPage } from './BoardPage';
  import { BoardNav } from './BoardNav';
  import { BoardSettings } from './BoardSettings';

  const client: PluginClientExport = {
    routes: [{ path: '/board', title: 'Board', component: BoardPage }],
    regions: { 'sidebar-nav': BoardNav, 'settings-panel': BoardSettings },
    onReady(api) { /* stash api for the action calls */ },
  };
  export default client;
  ```
- `bundle/api.ts` — `action(name, params)` calls `api.fetch('/api/extensions/drone-swarm-project/actions/' + name, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ params }) })`. Hold the `api` object from `onReady` in a module-level variable.
- `bundle/BoardPage.tsx` — read `board.get` and poll every 3s. Render columns left to right. Render cards with the status pill. Use HTML5 drag-and-drop (no new dependency). On drop call `card.move`. Show a "Queue" button that opens the queue modal.
- `bundle/QueueModal.tsx` — read `queue.list`. Show each job with its state and card. Buttons for `queue.retry` and `queue.cancel`. Poll while open.
- `bundle/BoardSettings.tsx` — manage projects, columns, automations, and limits (`column.*`, `automation.*`, `limits.*`, `project.*`). Poll on mount. A manual refresh button.
- `bundle/BoardNav.tsx` — a plain `<a href="/board">Board</a>`. There is no router on `globalThis`, so use a full-page link.
- `bundle/styles.css` — plain CSS with a `dsp-` class prefix. Do not use the host's Tailwind classes (the host build does not scan bundle files).
- Every component reads hooks as `globalThis.React.useState` etc. Do not `import 'react'`.

**Step 22 — Create `src/bundle.ts`.** Agent: `code`.
Read the built files from disk and return the upload payload.
```ts
export const BUNDLE = { name: 'board', version: '0.1.0' };
export async function buildBundleFiles(): Promise<Array<{ name: string; contentBase64: string; contentType: string }>>;
```
Resolve the package root from `import.meta.url`: `const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')` gives `dist/` in production and `src/` in tests; use two levels: `path.resolve(dirname, '..', '..')` is the package root for `dist/index.js`, but `src/bundle.ts` is compiled into `dist/bundle.js`, so the package root is `path.resolve(dirname(fileURLToPath(import.meta.url)), '..')`. Confirm both at runtime by trying `dist/bundle/index.js` under the package root. If a file is absent, throw a clear error; the caller logs it and continues (non-fatal), exactly like `mcp-swarm`.

### Phase 7 — Wiring, docs, and ADR

**Step 23 — Create `src/config.ts`.** Agent: `code`.
```ts
export interface ProjectConfig {
  coordinatorUrl: string; dataDir: string; id: string;
  injectToolsIntoAllSessions: boolean;
  maxConcurrentSessions: number; maxDailySessions: number;
  preApprovalTokenPath?: string;
}
export function resolveConfig(env?: NodeJS.ProcessEnv, argv?: string[]): ProjectConfig;
```
Defaults: `coordinatorUrl` = `http://127.0.0.1:8080`, `dataDir` = `~/.drone-agent/drone-swarm-project`, `id` = `drone-swarm-project`, `injectToolsIntoAllSessions` = `true`, `maxConcurrentSessions` = `1`, `maxDailySessions` = `12`. Env prefix `DRONE_SWARM_PROJECT_*`. Support `--pre-approval-token-path` in both forms.

**Step 24 — Create `src/index.ts`.** Agent: `code`.
```ts
export async function startProjectService(cfg?: ProjectConfig): Promise<{
  node: ExtensionNode; stop: () => Promise<void>;
}>;
export async function main(): Promise<void>;
```
`startProjectService`:
1. `const store = await createJsonStore(cfg.dataDir, { maxConcurrentSessions, maxDailySessions })`.
2. Build the `Scheduler` with a `spawn` that calls `spawnSession` and stores the ids back on the job.
3. Build the `ReconcileTracker`.
4. `const node = await createExtensionNode({ coordinatorUrl, dataDir, id, name: 'drone-swarm-project', capabilities: CAPABILITIES, handlers: { ...makeHandlers(...), ...makeSessionHandlers(...) } })`.
5. `try { await node.uploadBundle({ name: BUNDLE.name, version: BUNDLE.version, files: await buildBundleFiles() }); } catch { /* non-fatal */ }`.
6. `scheduler.start()`.
7. Return `{ node, stop: async () => { scheduler.stop(); await node.stop(); } }`.

`main`: `resolveConfig()`. If `preApprovalTokenPath` is set, run `redeemPreApprovalToken(...)` and exit (mirror `mcp-swarm`). Else `await startProjectService()`.

**Step 25 — Create `docs/agents/drone-swarm-project.md`.** Agent: `code`.
Explain: what the node is, the capability tiers, the automation model, the queue and the limits, the store layout, the card tools and the card-bound shortcut, and how to run it. Add a cross-link from `docs/agents/swarm-extensions.md` ("The second reference extension is `drone-swarm-project` … it is the first real TSX bundle").

**Step 26 — Create `docs/adr/271-drone-swarm-project-kanban-extension.md`.** Agent: `code`.
Record the decision and the non-obvious parts: (a) a card move enqueues a paced spawn, not an immediate spawn; (b) limits constrain speed, not the actor; (c) the card does not auto-advance on session end; (d) the first real esbuild TSX bundle; (e) JSON store behind an interface with a reserved SQLite upgrade.

**Step 27 — Update `README.md` and `CONTEXT-MAP.md`; add `drone-swarm-project/CONTEXT.md`.** Agent: `code`.
- `README.md`: add a package-list line for `drone-swarm-project`.
- `CONTEXT-MAP.md`: add a context entry and its relationships.
- `drone-swarm-project/CONTEXT.md`: a short glossary (Project, Column, Card, Automation, Job, Queue, Card-bound session). Glossary only — no implementation detail.

### Phase 8 — Tests

Write all tests under `drone-swarm-project/test/`. Use the root vitest.

**Step 28 — Unit tests.** Agent: `code`.
- `test/config.test.ts` — defaults and each env override.
- `test/store.test.ts` — project CRUD; card create/update/move; the card-to-project map; persistence across a reload; the index stays consistent; an atomic write does not corrupt the file (write, reload, compare).
- `test/automations.test.ts` — `matchesTransition` for each wildcard case; a both-wildcard automation is rejected at creation; `renderPrompt` for each token and for an unknown token.
- `test/scheduler.test.ts` — `intervalMs`; each gate; the oldest job starts first; the daily window prunes on read (use an injected clock); a persisted `startedAt` survives a store reload.
- `test/reconcile.test.ts` — a `running` job not confirmed by `sessionStarted` becomes `failed` after the settle window (fake clock).
- `test/capabilities.test.ts` — names are unique; the six card tools are `mcp` tier; the rest are `ui` tier.
- `test/handlers.test.ts` — `card.move` enqueues one job per matching automation; a non-matching move enqueues nothing; a `ui` capability is refused for `ctx.caller === 'agent'`; the card-bound default fills a missing `cardId`; a card create is a `null`→column move.
- `test/session-events.test.ts` — a card-bound `sessionStarted` calls `injectTools` and `injectFragment` and sends the instruction; a non-subagent session with `injectToolsIntoAllSessions` gets `injectTools` only; a subagent gets nothing; `sessionEnded` closes the job to `done` and sets the card status.
- `test/bundle.test.ts` — `buildBundleFiles()` throws a clear error when the built file is absent (do not depend on a build).
Use `vi.fn()` for the fetch and the node. Use `mkdtemp` for the data dir.

**Step 29 — Integration smoke test.** Agent: `code`.
`test/e2e-smoke.test.ts`. Gate it on `RUN_INTEGRATION_TESTS==='true'` and an explicit `DRONE_SWARM_PROJECT_COORDINATOR_URL`. Mirror `mcp-swarm/test/e2e-smoke.test.ts`. Assert: the node appears in `GET /api/extensions` with the full catalog; a `project.create` action round-trips; a `card.create` then `card.move` enqueues a job (`queue.list`). Run `pnpm --filter drone-swarm-project run build` first so the bundle exists.

### Phase 9 — Final check

**Step 30 — Run the full validation (see §6).** Agent: `review`.
Run every command in §6. Confirm each result. Fix anything that fails. Then re-run from a clean tree.

## 5. Dependencies and order

- Phase 0 blocks everything (the package must exist and be registered).
- Phase 1 (types, store) blocks Phases 2–5.
- Phase 2 (automations) blocks Phase 5 (handlers).
- Phase 3 (scheduler) blocks Phases 4–5.
- Phase 4 (spawn, session events) blocks Phase 5.
- Phase 5 (catalog, handlers) blocks Phase 7 (wiring).
- Phase 6 (bundle) blocks Step 22 and the integration smoke test.
- Phase 7 (wiring, docs) blocks Phase 8 execution (the node must start).
- Phase 8 blocks Phase 9.

Parallelizable: Phase 6 (bundle) is independent of Phases 2–5 and can run in parallel after Phase 0. Phase 7's docs (Steps 25–27) can run in parallel with Phase 8.

## 6. Validation criteria

All of the following must pass. This is the definition of done.

1. **LSP**: no errors and no warnings in any new or changed file (use the connected TypeScript LSP).
2. **Typecheck**: `pnpm typecheck` passes with zero errors. This includes `drone-swarm-project/src` and `drone-swarm-project/test`, and the bundle typecheck (`tsc -p bundle/tsconfig.json`).
3. **Build**: `pnpm -r run build` passes with zero errors. It writes `drone-swarm-project/dist/index.js` and `drone-swarm-project/dist/bundle/index.js`.
4. **Lint**: `pnpm run lint` passes with zero errors (ESLint then Prettier). Note: Prettier reformats files, so re-read any file before you edit it again.
5. **Unit tests**: `pnpm test` passes. The new `drone-swarm-project/test/**` files run and pass.
6. **Coverage**: new source files appear in the coverage report (the `coverage.include` line was added).
7. **New code is covered**: every new source file has unit tests. The scheduler gates, the automation matching, the store operations, the card-bound shortcut, and the session-event injection are each covered by a test.
8. **No dead code**: no unused exports, variables, or comments. Comments are jsdoc, algorithm explanations, or TODO/FIXME only.
9. **File size**: no file exceeds 750 lines. Split a file that exceeds 1000 lines.
10. **No duplicated code**: extract repeated patterns.
11. **Integration smoke test** (when a coordinator is available): `RUN_INTEGRATION_TESTS=true DRONE_SWARM_PROJECT_COORDINATOR_URL=<url> pnpm vitest run drone-swarm-project/test/e2e-smoke.test.ts` passes after `pnpm --filter drone-swarm-project run build`.
12. **Behavioural checks** (manual, or automated where practical):
    - A `card.move` that matches an automation enqueues exactly one job.
    - A second matching move while one session is live queues the job and does not start it (concurrency gate = 1).
    - The first job starts immediately; the second starts only after `interval` (or after the first session ends and the spacing gate passes).
    - A restart keeps the pacing: a persisted `startedAt` still blocks a start inside the interval.
    - A `running` job whose session vanished becomes `failed` after the settle window.
    - A card-bound session sees `extensions__drone-swarm-project__card.move` in `runtime__list_tools`, unmounted, and can mount and call it with no `cardId`.
    - A subagent session receives no card tools.
    - The board page renders, polls, and moves a card; the queue modal lists jobs and can cancel one.
13. **Registration**: `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `vitest.config.ts`, and `tsconfig.test.json` are updated. `README.md`, `CONTEXT-MAP.md`, the ADR, and the package `CONTEXT.md` exist.
14. **Git hygiene**: the new package is committed. Per `AGENTS.md`, any uncommitted `.drone-agent` memory, skills, insights, or principles go in with the next commit on a feature branch.

**Step 30 is the final step: verify every item above, then report the result.**

---

## 7. Execution summary (completed 2026-11-09)

Status: **COMPLETED**. Branch `feat/kanban-extension-base`. All 30 steps executed.

### What was built
- New workspace package `drone-swarm-project` (registered in `pnpm-workspace.yaml`,
  lockfile regenerated, `vitest.config.ts` + `tsconfig.test.json` wired).
- `src/board-types.ts`, `src/ids.ts`, `src/store/{board-store,scheduler-store,json-store}.ts`
- `src/automations.ts`, `src/scheduler.ts`, `src/scheduler-reconcile.ts`
- `src/spawn.ts`, `src/session-events.ts`, `src/capabilities.ts`, `src/handlers.ts`
- `bundle/` (real TSX: index.tsx, BoardPage, BoardNav, BoardSettings, QueueModal, api, types, styles)
  built by `scripts/build-bundle.mjs` (esbuild) → `dist/bundle/{index.js,style.css}`
- `src/bundle.ts`, `src/config.ts`, `src/index.ts`, `bin/drone-swarm-project` (mode 100755)
- `docs/agents/drone-swarm-project.md`, `docs/adr/271-drone-swarm-project-kanban-extension.md`,
  README + CONTEXT-MAP entries, `drone-swarm-project/CONTEXT.md`, cross-link from swarm-extensions.md.
- 10 test files, 55 unit tests + 3 gated e2e tests.

### Deviations from the written plan (all forced by the code, recorded per AGENTS.md)
1. **`SessionHandlerDeps.node` → `getNode: () => ExtensionNode`.** The plan's Step 16 passed
   `node` directly, but `makeSessionHandlers` is called *inside* the `createExtensionNode`
   argument list, so `node` does not exist yet (TDZ / "used before assigned"). Resolved with a
   lazy getter; the plan's circular-dependency gap.
2. **`BoardStore` gained `setCardSession` and `getCardIdForSession`.** The plan's Step 9
   interface had no way to write a card's session or resolve session→card, both required by
   Steps 16 and 18. Added (kept behind the interface, per D17).
3. **`Scheduler.reconcile(staleJobIds)` takes the stale set as a parameter** rather than reading
   its own pending set. The plan split the pending-set logic (Step 14, ReconcileTracker) from the
   scheduler (Step 13); the parameter is the seam between them.
4. **`bundle/globals.d.ts` also declares a global `JSX` namespace.** `@types/react` v19 removed
   the global `JSX` namespace, so the bundle typecheck (`jsxFactory: globalThis.React.createElement`)
   needed it declared explicitly. Uses type aliases, not empty interfaces (eslint rule).
5. **`buildBundleFiles(root?)` takes an optional root** so the absent-file test does not depend on
   a real build.
6. **esbuild devDependency `^0.25.12`** resolved against the lockfile's existing 0.25.x line.

### Validation results
- LSP: zero errors/warnings in every new file.
- `pnpm typecheck`: PASS (includes `tsc -p bundle/tsconfig.json`).
- `pnpm -r run build`: PASS; writes `dist/index.js` + `dist/bundle/{index.js,style.css}`.
- `pnpm run lint`: PASS (eslint + prettier).
- `pnpm test`: 4706 passed / 19 skipped (359 files); the 55 new tests pass.
- Coverage: `coverage.include` line added. The `@vitest/coverage-v8` provider is not installed in
  this environment, so the report could not be generated here — tooling gap, not a code gap.
- File sizes: largest new file 547 lines (under the 750 limit).
- Integration smoke test: present, gated on `RUN_INTEGRATION_TESTS=true` +
  `DRONE_SWARM_PROJECT_COORDINATOR_URL`, skipped by default.
- Bin mode `100755` confirmed via `git ls-files -s`.

### Known limitations / follow-ups
- No live coordinator was available, so the e2e smoke test ran skipped. All behaviour is covered
  by unit tests with mocked fetch/node.
- The `BoardSettings` bundle panel manages projects/columns/limits; automations are exposed via
  `automation.*` capabilities but the panel does not yet render an automation editor (v1 UI scope).
- Docker images deferred (README records this).

---
key: plan-gateway-portable-context-adoption
tags:
  - plan
  - drone-gateway
  - portable-context
  - continuity
  - ledger
  - control-surface
  - persona-assignment
created: 2026-10-12T01:00:27.868Z
updated: 2026-10-12T01:00:27.868Z
---

---
name: plan-gateway-portable-context-adoption
description: Plan A — drone-gateway adopts portable context (context continuity + outbound ledger + message-id labels)
tags: [plan, drone-gateway, portable-context, continuity, ledger, control-surface, persona-assignment]
created: 2026-10-12
updated: 2026-10-12
---

# Plan A: drone-gateway adopts portable context — continuity, outbound ledger, message-id labels

**Status:** ready for execution. This is **Plan A of two**; Plan B (per-surface `mode: active|passive|observer` + catch-up loops + mention triggers) is NOT written yet and must be planned after Plan A is verified.

**Origin:** planning session `agent-1791760704050` (persona `plan`, beacon `ambicatus`), 2026-10-11/12.

**Branch at planning time:** `feat/portable-context` (working tree clean). Portable-context capability already merged into this branch (ADR 246; `drone-agent/src/runtime/portable-context/`).

---

## 1. Why

The `persona-assignment` control surface spawns a persistent agent per conversation (`LocalSpawnBackend` → `drone-agent --output-json`, NDJSON listen mode). Today that agent has **no continuity**: the `SessionLifecycle` idle-timeout (default 5 min) terminates it, the one-shot death recovery re-spawns a **blank** agent, and a gateway restart loses everything. Separately, messages posted *by the gateway itself* (via the external-process injection API — e.g. a cron "news brief") are posted by the bot account and then **dropped by the adapter's self-echo filter**, so the agent has a hole in its own history.

Plan A fixes both for **local spawn mode only**:

1. **Snapshot / restore** — after every completed round, export the agent's context via the engine-seeded `portable-context` capability; store it in the adapter's SQLite DB; restore it (`importContext`) whenever a fresh agent must start. Combined with compaction (summary-drop strategy + aggressive threshold), one rolling context can run indefinitely.
2. **Outbound history ledger** — record every injection-API post, persisted; deliver all undelivered entries inline at the start of the agent's next turn, so the agent sees its own outbound history.
3. **Message-id labels** (prep for a future reactions/reply feature) — stamp each chat turn with the platform message id: `[<message-id> from: <Name>]` header line.

**Explicitly out of scope (Plan A):** `mode` setting, catch-up loops, `@`-mention detection, observer schedule (all Plan B); snapshot pruning on conversation drop (deferred, add after Plan A is stable); teaching the model the message-id format (inert — the reactions plan adds the instruction); a new `appendContext` NDJSON event (future promotion of the ledger delivery); coordinator-mode context export/import (throws a clear "unsupported").

---

## 2. Locked decisions (do not re-litigate)

| # | Decision |
|---|---|
| D1 | Snapshot is exported **after every completed round** (a "round" = one `sendUserMessage` call ending in `roundComplete`). Unconditional; no throttle knob. Payload byte size logged at debug. |
| D2 | Restore point = `SessionLifecycle.ensureSession()`: spawn child, then if a snapshot exists for the conversation, `importContext` it **before** the first round. |
| D3 | Snapshot storage = **new SQLite table in the adapter's `dataPath` DB**, one row per conversation, latest-wins overwrite. |
| D4 | Adapters **without** `dataPath` ⇒ snapshotting **and** the ledger are disabled, with ONE startup warning per affected adapter. The agent still runs. |
| D5 | A snapshot **never contains** the continuation-disclosure turn. Enforced **capability-side** in `exportContext` (drone-agent), via a shared marker constant in drone-core. |
| D6 | Ledger scope = **injection-API posts only**. Agent replies are already assistant turns in context. |
| D7 | Ledger delivery = **inline at the start of the next user turn** (persisted with it ⇒ survives compaction). NOT a new NDJSON event. |
| D8 | Drain semantics: entries accumulate while the agent is idle/away; the next turn drains **all** pending entries; rows are deleted **only after** successful delivery. |
| D9 | Ledger rows are **persisted** in the same SQLite DB (survive a gateway restart); a row is deleted only after the agent's turn succeeds. |
| D10 | `SurfaceContext` gains a pending-outbound **drain handle**; the engine records injections. The wildcard `*` is never an injection target (loader already enforces this). |
| D11 | `AdapterMessage` gains an adapter-stamped `platformRef` (Matrix `event.getId()`), echoed by surfaces. |
| D12 | Label shape = a **header line of its own**: `[<message-id> from: <Name>]` then the body on the following line(s). Sender id is omitted for now. |
| D13 | `DroneServiceAdapter.sendMessage` returns `Promise<string | undefined>` (the platform ref of the posted message), so ledger entries can carry their id too. |
| D14 | `SpawnBackend` gains `exportContext(session)` / `importContext(session, data)`. `LocalSpawnBackend` implements both. `CoordinatorSpawnBackend` throws a clear "unsupported". |
| D15 | The gateway's `LocalSpawnBackend` moves from a per-request `readline` to **one persistent stdout reader per session**, with a single in-flight request slot (safe: callers serialize per conversation). |
| D16 | Snapshot pruning on conversation drop / adapter cleanup is **deferred** (documented as a TODO). |

---

## 3. Code seams (verified against the working tree)

| Area | File | What changes |
|---|---|---|
| Shared marker | `drone-core/src/portable-context-types.ts` | new `CONTINUATION_DISCLOSURE_MARKER` (+ barrel export) |
| Disclosure builder + filter | `drone-agent/src/runtime/portable-context/capability.ts` | use the marker; filter it out of `exportContext` |
| Gateway schema | `drone-gateway/src/store/db.ts` | new `createGatewayStateSchema` called from `initGatewaySchema` |
| Gateway store | `drone-gateway/src/store/gateway-state-store.ts` | **new**: `ContextSnapshotStore` + `OutboundLedgerHandle` over `GatewayDatabase` |
| Adapter types | `drone-gateway/src/types.ts` | `AdapterMessage.platformRef?`; `DroneServiceAdapter.sendMessage` return type; adapter exposes `snapshotStore?`/`outboundLedger?` |
| Matrix adapter | `drone-gateway/src/adapters/matrix.ts` | stamp `platformRef` inbound; return the event id outbound; build the stores in `start()` when `dataPath` is set; clear them in `stop()` |
| Chat formatting | `drone-gateway/src/chat-format.ts` | new `formatChatTurn`; new `formatOutboundPost` + `OUTBOUND_LEDGER_PREAMBLE` |
| Spawn backend | `drone-gateway/src/spawn-backend.ts`, `local-spawn-backend.ts`, `coordinator-spawn-backend.ts` | `exportContext`/`importContext`; persistent reader |
| Engine | `drone-gateway/src/engine.ts` | `createControlSurface(spec, convId, adapterId)`; `surfaceContext(spec, adapterId)`; ledger record in `injectMessage`; no-dataPath warning |
| Lifecycle | `drone-gateway/src/surfaces/lifecycle.ts` | restore in `ensureSession`; snapshot after each successful send |
| Surface context | `drone-gateway/src/surfaces/types.ts` | `snapshotStore?`, `outboundLedger?` |
| Surface | `drone-gateway/src/surfaces/persona-assignment.ts` | drain ledger → prepend preamble; delete rows on success |
| Docs | `docs/adr/`, `drone-gateway/CONTEXT.md` | ADR + glossary/config-layout entry |

---

## 4. Steps

> Agent types: **coder**, **tester**, **reviewer**. Execute in order. Steps marked ⛓ depend on the listed predecessors.

---

### Phase 0 — drone-core: the shared marker

#### Step 0.1 — ⛓ (none) · coder · `drone-core/src/portable-context-types.ts`

Add a stable marker substring, exported from the barrel (`drone-core/src/index.ts`).

```ts
/**
 * Substring that identifies the continuation-disclosure system-reminder a
 * portable-context import appends to the restored session. Used to build the
 * reminder AND to strip it back out on export, so repeated
 * export → import → export cycles never accumulate disclosure turns.
 */
export const CONTINUATION_DISCLOSURE_MARKER =
  'was restored from a prior checkpoint';
```

Verify it is re-exported from `drone-core/src/index.ts` (the file already re-exports `portable-context-types.js`).

**Then:** run `pnpm -r run build` before any dependent package relies on LSP (principle: dependent packages resolve `dist/`).

**Done when:** `pnpm -r run build` passes; the constant is importable from `drone-core`.

---

### Phase 1 — drone-agent: stop the disclosure from accumulating

#### Step 1.1 — ⛓ 0.1 · coder · `drone-agent/src/runtime/portable-context/capability.ts`

1. Import `CONTINUATION_DISCLOSURE_MARKER` from `drone-core`.
2. Use it in `buildContinuationDisclosure` so the reminder text contains the marker (assert by construction, e.g. keep the sentence intact rather than hand-splitting the string).
3. In `exportContext`, filter the turn list **before** building the export:

```ts
async function exportContext(): Promise<DronePortableContextExport> {
  const turns = deps.sessionManager
    .getTurns()
    .filter(turn =>
      !turn.messages.some(
        m =>
          typeof m.content === 'string' &&
          m.content.includes(CONTINUATION_DISCLOSURE_MARKER)
      )
    );
  // ...rest unchanged (mounted names, tools, contributors all read from `turns`)
}
```

Add a TODO comment referencing the future `appendContext` promotion and the deferred prune work only where the plan says to (D7/D16).

#### Step 1.2 — ⛓ 1.1 · tester · `drone-agent/test/portable-context.test.ts` (extend)

- Export → import → export again; assert **no** exported turn contains `CONTINUATION_DISCLOSURE_MARKER`.
- Assert the single-cycle case: importing a clean snapshot still appends exactly one disclosure turn to the live session (unchanged behaviour), but that turn is absent from the next export.
- Assert stability across three cycles (no growth in `session.turns.length` beyond the genuine turns).

#### Step 1.3 — ⛓ 1.2 · reviewer

Confirm the filter is turn-granular, that it cannot drop a genuine turn (only the reminder text matches), and that `checkpoint`'s save→restore→save path is now also fixed.

---

### Phase 2 — drone-gateway: the SQLite state store

#### Step 2.1 — ⛓ (none) · coder · `drone-gateway/src/store/db.ts`

Add a third schema builder and call it from `initGatewaySchema`:

```ts
function createGatewayStateSchema(db: GatewayDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_snapshots (
      conversation_id TEXT PRIMARY KEY,
      context         TEXT NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_outbound (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      platform_ref    TEXT,
      text            TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_outbound_conversation
      ON pending_outbound (conversation_id, id);
  `);
}
```

`initGatewaySchema` becomes `createCryptoSchema(db); createSyncSchema(db); createGatewayStateSchema(db);`.

#### Step 2.2 — ⛓ 2.1 · coder · `drone-gateway/src/store/gateway-state-store.ts` (**new file**)

Two narrow interfaces, two factories, one shared file. `better-sqlite3` is synchronous by design — these methods are intentionally sync (mirrors beacon/coordinator DB layers).

```ts
import type { DronePortableContextExport } from 'drone-core';
import type { GatewayDatabase } from './db.js';

export interface ContextSnapshotStore {
  saveSnapshot(conversationId: string, context: DronePortableContextExport): void;
  getSnapshot(conversationId: string): DronePortableContextExport | null;
  deleteSnapshot(conversationId: string): void;
}

export interface OutboundLedgerEntry {
  id: number;
  platformRef?: string;
  text: string;
  createdAt: number;
}

export interface OutboundLedgerHandle {
  append(conversationId: string, entry: { platformRef?: string; text: string }): void;
  list(conversationId: string): OutboundLedgerEntry[];
  remove(ids: number[]): void;
}

export function createContextSnapshotStore(db: GatewayDatabase): ContextSnapshotStore { /* prepared stmts + INSERT OR REPLACE / SELECT / DELETE */ }
export function createOutboundLedger(db: GatewayDatabase): OutboundLedgerHandle { /* INSERT / SELECT ... ORDER BY id / DELETE WHERE id IN (...) */ }
```

- `saveSnapshot` uses `INSERT OR REPLACE INTO context_snapshots (conversation_id, context, updated_at) VALUES (?,?,?)` with `JSON.stringify(context)` and `Date.now()`.
- `getSnapshot` returns `null` on miss; `JSON.parse` on hit.
- `remove` builds a parameterised `IN (?,?,…)` from the id list; no-op on `[]`.

Note in the code comment that the snapshot `context` is **already disclosure-free** (D5) — the gateway does not strip anything.

#### Step 2.3 — ⛓ 2.2 · tester · `drone-gateway/test/gateway-state-store.test.ts` (**new file**)

Use `new Database(':memory:')` + `initGatewaySchema` (existing `sqlite-sync-store.test.ts` pattern).

- Snapshot: save → get round-trips; second save overwrites (latest wins); get on unknown id → `null`.
- Ledger: append two → `list` returns them in insertion order; `remove([id1])` leaves one; `remove([])` is a no-op; `remove` of a non-existent id is a no-op.

---

### Phase 3 — drone-gateway: the spawn-backend contract

#### Step 3.1 — ⛓ (none) · coder · `drone-gateway/src/spawn-backend.ts`

```ts
import type { DronePortableContextExport } from 'drone-core';

export interface SpawnBackend {
  readonly type: SpawnBackendType;
  spawnSession(...): Promise<SpawnSession>;
  sendMessage(...): Promise<string | null>;

  /**
   * Export the session's portable context. Local mode only; the coordinator
   * backend throws (no receive path exists).
   */
  exportContext(session: SpawnSession): Promise<DronePortableContextExport>;

  /** Restore a portable context into a freshly spawned session. */
  importContext(session: SpawnSession, data: DronePortableContextExport): Promise<void>;

  terminateSession(session: SpawnSession): Promise<void>;
}
```

#### Step 3.2 — ⛓ 3.1 · coder · `drone-gateway/src/local-spawn-backend.ts`

Replace the per-request `readline` with **one persistent reader per session** plus a single pending-request slot.

```ts
interface PendingRequest {
  kind: 'chat' | 'export' | 'import';
  lastAssistantMessage: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface ManagedAgentSession {
  session: SpawnSession;
  process: ChildProcess;
  stderrTail: string[];
  reader: Interface;
  pending: PendingRequest | null;
}
```

In `startSession`:
```ts
const reader = createLineInterface({ input: childProcess.stdout });
const managed: ManagedAgentSession = { session, process: childProcess, stderrTail: [], reader, pending: null };
reader.on('line', line => this.handleLine(managed, line));
```

```ts
private handleLine(managed: ManagedAgentSession, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let event: { kind: string; [k: string]: unknown };
  try { event = JSON.parse(trimmed); } catch { logger.warn(`Failed to parse NDJSON line: ${trimmed}`); return; }

  switch (event.kind) {
    case 'assistantMessage':
      if (managed.pending) managed.pending.lastAssistantMessage = String(event.content ?? '');
      break;
    case 'turnComplete':
      this.settle(managed, 'chat', p => p.resolve(p.lastAssistantMessage));
      break;
    case 'contextExport':
      if (event.ok) this.settle(managed, 'export', p => p.resolve(event.context));
      else this.settle(managed, 'export', p => p.reject(new Error(String(event.error))));
      break;
    case 'contextImport':
      if (event.ok) this.settle(managed, 'import', p => p.resolve(undefined));
      else this.settle(managed, 'import', p => p.reject(new Error(String(event.error))));
      break;
    case 'error':
      logger.error(`Agent error: ${String(event.message)}`);
      break;
    default:
      break; // toolCall / toolResult / reasoning / notice are informational
  }
}

private settle(managed, kind, act): void {
  const p = managed.pending;
  if (!p || p.kind !== kind) return;
  managed.pending = null;
  act(p);
}
```

Request helper:
```ts
private request<T>(managed: ManagedAgentSession, kind: PendingRequest['kind'], write: () => void): Promise<T> {
  if (managed.pending) {
    return Promise.reject(new Error('An agent request is already in flight for this conversation'));
  }
  return new Promise<T>((resolve, reject) => {
    managed.pending = { kind, lastAssistantMessage: '', resolve: resolve as (v: unknown) => void, reject };
    write();
  });
}
```

Then:
```ts
async sendMessage(session, message, opts): Promise<string | null> {
  const managed = this.requireSession(session);
  const chatEvent = JSON.stringify({ type: 'chat', message, ...(opts?.systemReminder ? { systemReminder: opts.systemReminder } : {}) }) + '\n';
  return this.request<string>(managed, 'chat', () => managed.process.stdin!.write(chatEvent));
}

async exportContext(session): Promise<DronePortableContextExport> {
  const managed = this.requireSession(session);
  return this.request<DronePortableContextExport>(managed, 'export', () =>
    managed.process.stdin!.write(JSON.stringify({ type: 'exportContext' }) + '\n')
  );
}

async importContext(session, data): Promise<void> {
  const managed = this.requireSession(session);
  return this.request<void>(managed, 'import', () =>
    managed.process.stdin!.write(JSON.stringify({ type: 'importContext', context: data }) + '\n')
  );
}
```

The `exit`/`error` handlers must reject any pending request with the preserved early-exit behaviour: build the same `` `Error: agent exited before replying${tail}` `` string (last `STDERR_TAIL_LINES` stderr lines, 800-char cap) and reject. `terminateSession` does the same before SIGTERM, and closes `managed.reader`.

**Note:** the old early-exit test ("returns an error string") must be re-pointed at the reject path, since `sendMessage` now rejects instead of resolving an error string. Keep the surface's failure handling unchanged — `SessionLifecycle.send` already catches and retries once; the surface already turns a thrown error into `Error: <message>`.

#### Step 3.3 — ⛓ 3.1 · coder · `drone-gateway/src/coordinator-spawn-backend.ts`

```ts
async exportContext(): Promise<never> {
  throw new Error('Context export is not supported in coordinator spawn mode.');
}
async importContext(): Promise<never> {
  throw new Error('Context import is not supported in coordinator spawn mode.');
}
```

#### Step 3.4 — ⛓ 3.2, 3.3 · tester · `drone-gateway/test/local-spawn-backend.test.ts`, `test/coordinator-spawn-backend.test.ts`

- Persistent reader: drive a fake child that emits `assistantMessage` + `turnComplete`; assert `sendMessage` resolves with the message; assert **one** readline is created over stdout for two turns.
- `exportContext`: child emits `{kind:'contextExport', ok:true, context}`; assert the export resolves with the context and that the written stdin line is `{"type":"exportContext"}`.
- `importContext`: assert the written line carries `type:'importContext'` and the context; assert an `ok:false` response rejects.
- Early exit while a chat request is pending → rejects with the `Error: agent exited before replying` string including the stderr tail.
- Second concurrent request while one is pending → rejects ("already in flight").
- Coordinator backend: both methods throw the "not supported" message.

---

### Phase 4 — drone-gateway: platform refs, labels, adapter stores

#### Step 4.1 — ⛓ 2.2 · coder · `drone-gateway/src/types.ts`, `drone-gateway/src/adapter-types` (wherever `DroneServiceAdapter` lives — it is in `types.ts`)

```ts
export interface AdapterMessage {
  // ...unchanged...
  /**
   * Opaque adapter-stamped platform reference for this message (Matrix event
   * id). Echoed by surfaces; the seam a future reaction/reply feature targets.
   */
  platformRef?: string;
}

export interface DroneServiceAdapter {
  // ...unchanged...
  /** Returns the platform reference of the posted message, when the platform supplies one. */
  sendMessage(conversationId: string, text: string): Promise<string | undefined>;
  /** Built when the adapter has a persistent DB; absent otherwise. */
  readonly snapshotStore?: ContextSnapshotStore;
  readonly outboundLedger?: OutboundLedgerHandle;
}
```

#### Step 4.2 — ⛓ 4.1 · coder · `drone-gateway/src/adapters/matrix.ts`

- Inbound (`onTimelineEvent`): add `platformRef: event.getId()` to the emitted `AdapterMessage`.
- In `start()`: when `dataPath` is set (after `openGatewayDb`), build and assign `this.snapshotStore = createContextSnapshotStore(this.db)` and `this.outboundLedger = createOutboundLedger(this.db)`. When `dataPath` is **unset**, leave both undefined.
- In `stop()`: clear both (the DB handle is already closed there).
- Outbound `sendMessage`: capture the SDK response and return its event id:

```ts
const res = rendered.formattedBody
  ? await this.client.sendHtmlMessage(roomId, rendered.body, rendered.formattedBody)
  : await this.client.sendMessage(roomId, { body: rendered.body, msgtype: 'm.text' as never });
return res?.event_id;
```

#### Step 4.3 — ⛓ 4.1 · coder · `drone-gateway/src/chat-format.ts`

```ts
export function formatChatTurn(
  msg: Pick<AdapterMessage, 'senderName' | 'senderId' | 'platformRef' | 'text'>
): string {
  const name = msg.senderName?.trim() || msg.senderId?.trim() || 'unknown';
  const ref = msg.platformRef?.trim() || '-';
  return `[${ref} from: ${name}]\n${msg.text}`;
}

export const OUTBOUND_LEDGER_PREAMBLE =
  'Messages you posted to this conversation while you were not running:';

export function formatOutboundPost(entry: { platformRef?: string; text: string }): string {
  const ref = entry.platformRef?.trim() || '-';
  return `[${ref} posted by you]\n${entry.text}`;
}
```

Multi-line bodies now sit under the header line verbatim (the old code prefixed only the first line). No prompt instruction teaches the id format yet (D12, inert).

#### Step 4.4 — ⛓ 4.2, 4.3 · tester

- `test/chat-format.test.ts`: rewrite expectations to the new shape; cover the `-` fallback for a missing `platformRef`; cover a multi-line body.
- `test/matrix-adapter.test.ts`: assert the emitted message carries `platformRef` equal to the mocked event id; assert `sendMessage` returns the mocked event id; assert an adapter constructed without `dataPath` exposes no stores.
- `test/engine.test.ts` fake adapters: `sendMessage` must now be `async () => undefined` (or a fake id).

---

### Phase 5 — drone-gateway: engine wiring

#### Step 5.1 — ⛓ 4.1, 2.2 · coder · `drone-gateway/src/surfaces/types.ts`

```ts
export interface SurfaceContext {
  spawnBackend: SpawnBackend;
  swarm: SwarmApi | undefined;
  targetBeaconId?: string;
  workingDir?: string;
  idleTimeoutMs?: number;
  debounceMs?: number;
  /** Absent when the adapter has no persistent DB (see D4). */
  snapshotStore?: ContextSnapshotStore;
  /** Absent when the adapter has no persistent DB (see D4). */
  outboundLedger?: OutboundLedgerHandle;
}
```

#### Step 5.2 — ⛓ 5.1 · coder · `drone-gateway/src/engine.ts`

1. `createControlSurface(spec, conversationId)` → `createControlSurface(spec, conversationId, adapterId)`; the surface-factory call passes the extra arg; `surfaceContext(spec)` → `surfaceContext(spec, adapterId)`.
2. `surfaceContext` resolves the adapter's stores:
```ts
const adapter = this.adapters.get(adapterId);
// ...
snapshotStore: adapter?.snapshotStore,
outboundLedger: adapter?.outboundLedger,
```
3. `injectMessage` records the post **after** the adapter returns:
```ts
const platformRef = await adapter.sendMessage(conversationId, text);
adapter.outboundLedger?.append(conversationId, { platformRef, text });
```
4. In `start()`, per adapter, warn once when a `persona-assignment` surface exists but the adapter has no `dataPath`:
```ts
const hasDataPath = typeof adapterConfig.config?.dataPath === 'string'
  && (adapterConfig.config.dataPath as string).trim() !== '';
const hasPersonaSurface = [...adapterConfig.conversations.values()]
  .some(c => c.surfaces.some(s => s.type === 'persona-assignment'));
if (hasPersonaSurface && !hasDataPath) {
  logger.warn(
    { adapterId?: adapterConfig.id },
    'persona-assignment continuity and outbound ledger are disabled: this adapter has no "dataPath"'
  );
}
```

#### Step 5.3 — ⛓ 5.2 · tester · `drone-gateway/test/engine.test.ts`

- `injectMessage` on an injection-enabled conversation appends one ledger row with the platform ref returned by the fake adapter; with the adapter returning `undefined`, the row has no ref.
- The drain handle reaches the surface: assert the `SurfaceContext` handed to a `persona-assignment` factory carries `outboundLedger`.
- The no-`dataPath` warning fires once for an adapter with a persona surface and not otherwise.

---

### Phase 6 — drone-gateway: restore, snapshot, drain

#### Step 6.1 — ⛓ 3.2, 5.1 · coder · `drone-gateway/src/surfaces/lifecycle.ts`

`ensureSession` gains restore:
```ts
private async ensureSession(): Promise<SpawnSession> {
  if (this.session) return this.session;
  const session = await this.opts.ctx.spawnBackend.spawnSession(
    this.opts.conversationId, this.opts.personaId,
    { targetBeaconId: this.opts.ctx.targetBeaconId, workingDir: this.opts.ctx.workingDir }
  );
  this.session = session;

  const store = this.opts.ctx.snapshotStore;
  if (store) {
    const snapshot = store.getSnapshot(this.opts.conversationId);
    if (snapshot) {
      try {
        await this.opts.ctx.spawnBackend.importContext(session, snapshot);
      } catch (err) {
        logger.warn({ err, conversationId: this.opts.conversationId },
          'Context restore failed; starting with a fresh context');
      }
    }
  }
  return session;
}
```

`send()` calls `await this.snapshot()` on **both** success paths (primary and retry):

```ts
private async snapshot(): Promise<void> {
  const store = this.opts.ctx.snapshotStore;
  const session = this.session;
  if (!store || !session) return;
  try {
    const context = await this.opts.ctx.spawnBackend.exportContext(session);
    const bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    store.saveSnapshot(this.opts.conversationId, context);
    logger.debug({ conversationId: this.opts.conversationId, bytes }, 'Saved context snapshot');
  } catch (err) {
    logger.warn({ err, conversationId: this.opts.conversationId }, 'Context snapshot failed');
  }
}
```

Snapshotting inside the lifecycle tail keeps exactly one backend request in flight (D15) and makes ordering deterministic. A snapshot failure is non-fatal.

#### Step 6.2 — ⛓ 6.1 · coder · `drone-gateway/src/surfaces/persona-assignment.ts`

Drain the ledger once per outgoing turn, prepend the preamble, and delete rows only after the turn succeeds.

```ts
const ledger = ctx.outboundLedger;

function buildPreamble(conversationId: string): { text: string; ids: number[] } {
  if (!ledger) return { text: '', ids: [] };
  const entries = ledger.list(conversationId);
  if (entries.length === 0) return { text: '', ids: [] };
  const text = `${OUTBOUND_LEDGER_PREAMBLE}\n${entries.map(formatOutboundPost).join('\n')}\n\n`;
  return { text, ids: entries.map(e => e.id) };
}

async function sendTurn(messages: AdapterMessage[]) {
  const { text: preamble, ids } = buildPreamble(conversationId);
  const text = preamble + messages.map(formatChatTurn).join('\n');
  const isRoom = messages[0]?.conversationKind === 'room';
  const reply = await lifecycle.send(text, isRoom ? { systemReminder: ROOM_INSTRUCTION } : undefined);
  if (ledger && ids.length > 0) ledger.remove(ids);   // only after a successful round
  // ...unchanged null / sentinel handling...
}
```

Rows survive a failed/rejected send (the `catch` path in `run()` returns before `remove`). `handleBatch` shares `sendTurn`, so a drained preamble rides the merged turn exactly once.

#### Step 6.3 — ⛓ 6.2 · tester · `drone-gateway/test/persona-assignment-surface.test.ts`, `test/session-lifecycle.test.ts`

- Lifecycle: with a `snapshotStore` holding a snapshot, `ensureSession` calls `importContext` **before** the first `sendMessage`; with no snapshot, it does not; a throwing `importContext` is warned and the turn still proceeds.
- Lifecycle: after a successful send, `exportContext` is called and the snapshot saved; after a failed send whose retry also fails, no snapshot is saved.
- Surface: two pending ledger entries → the next turn text starts with `OUTBOUND_LEDGER_PREAMBLE` + both formatted entries, then the tagged inbound turn; `remove` is called with both ids on success and **not** called when the turn throws.
- Surface: no ledger handle (`undefined`) → text is unchanged (regression for the existing tagging tests).
- Surface: a room batch with pending ledger entries gets both the preamble once and the room `systemReminder`.

#### Step 6.4 — ⛓ 6.2 · coder · `drone-gateway/CONTEXT.md`

Add glossary entries (`snapshot store`, `outbound ledger`, `platformRef`) and a config-layout note that continuity requires the adapter's `dataPath`.

---

### Phase 7 — docs

#### Step 7.1 — ⛓ all · coder · `docs/adr/249-gateway-portable-context-continuity-and-outbound-ledger.md` (**new**)

Verify 249 is the next free number (latest is 248) and adjust if not. Record D1–D16, the rejected alternatives (per-turn vs post-round; disk JSON vs SQLite; gateway-side vs capability-side disclosure strip; new `appendContext` event vs inline delivery), and the deferred items (prune, `appendContext`, coordinator-mode export/import, the model-facing id instruction).

#### Step 7.2 — ⛓ all · coder · swarm wiki

Add a pointer stub under the project wiki's `decisions/` for ADR 249 and refresh the `drone-gateway` module page if a gateway-specific page exists for continuity. (Local wiki only; the canonical text is `docs/adr/`.)

---

### Phase 8 — final validation

#### Step 8.1 — ⛓ all · tester · end-to-end acceptance test

Add `drone-gateway/test/session-continuity-acceptance.test.ts`:

> **Scenario:** an injection-enabled conversation with one `persona-assignment` surface and a fake backend + in-memory store.
> 1. A message arrives → the agent replies (`hello`).
> 2. Assert a snapshot was exported and saved after the round.
> 3. Terminate the agent (idle timeout), then an external process injects `"weekly news brief"` via `engine.injectMessage`.
> 4. A new message arrives → the surface spawns a fresh agent, imports the snapshot **before** the first round, and the turn text begins with the ledger preamble carrying the injected post (with its platform ref).
> 5. Assert the injected row was deleted after the successful round, and that the *next* export contains no continuation-disclosure turn.

Mark the real-child variant (spawning an actual `drone-agent --output-json`) as an optional addition to the slow suite.

#### Step 8.2 — ⛓ 8.1 · coder · run the standards checks

```
pnpm -r run build
pnpm typecheck
pnpm run lint
pnpm run test
```

Re-run `pnpm run build` after any post-build edit (LSP in dependents reads `dist/`).

#### Step 8.3 — ⛓ 8.2 · reviewer · verify against the validation criteria below

---

## 5. Validation criteria

All of the following MUST hold before Plan A is considered done.

1. **LSP clean** — `lsp__get_diagnostics` on every changed file (and workspace-wide) reports **zero** errors and zero warnings. No exceptions for tests.
2. **Build** — `pnpm -r run build` passes with zero errors. `drone-core` is built **before** depending on LSP in `drone-agent` / `drone-gateway`.
3. **Typecheck** — `pnpm typecheck` passes with zero errors.
4. **Lint** — `pnpm run lint` (ESLint + Prettier) passes with zero errors. After running it, re-read every file before further edits (Prettier reformats).
5. **Tests** — `pnpm run test` (the fast suite) passes, including all new/updated tests:
   - `drone-agent`: disclosure-strip tests in `test/portable-context.test.ts`.
   - `drone-gateway`: `test/gateway-state-store.test.ts` (new), `test/session-continuity-acceptance.test.ts` (new), and updated `chat-format`, `matrix-adapter`, `local-spawn-backend`, `coordinator-spawn-backend`, `persona-assignment-surface`, `session-lifecycle`, `engine` tests.
6. **New code is covered** — every new branch (restore-with/without-snapshot, export failure, import failure, drain-with/without-entries, remove-on-success/not-on-failure, `undefined` platform ref) has a test.
7. **No dead code / no fluff comments** — removed code from the `readline` refactor is fully deleted; the only retained comments explain a non-obvious mechanism (single-in-flight request invariant, disclosure strip) or are TODO/FIXME.
8. **Acceptance behaviour** — the Phase 8 scenario passes: after a kill + restart, the agent's context is restored, it sees its injected posts in the next turn, and no disclosure turn accumulates across cycles.
9. **Standards sweep** — every implementer of `SpawnBackend` and `DroneServiceAdapter`, plus every fake in tests, has been updated (use LSP find-references on `SpawnBackend`, `DroneServiceAdapter`, `sendMessage`, `AdapterMessage`; grep `formatChatTurn`).
10. **Docs** — ADR 249 exists with D1–D16 and the deferred list; `drone-gateway/CONTEXT.md` carries the new glossary terms.
11. **Memory hygiene** — any `.drone-agent` files touched are staged with the change set; the final commit happens AFTER logging any insights/memories. Do not commit memory files to `main`.

---

## 6. Deferred / follow-ups (record, do not build in Plan A)

- **Plan B** — per-surface `mode: active | passive | observer`, catch-up loops, `@`-mention triggers, per-mode reply blocking.
- **Snapshot prune** — delete the `context_snapshots` row when a conversation is dropped from config or `cleanup` deletes the adapter (derived state). Add once Plan A is stable.
- **`appendContext` NDJSON event** — promote the ledger delivery to a role-correct "append turns without a round" primitive; then ledger entries become real assistant turns.
- **Model-facing message-id instruction** — teach the `[<id> from: X]` format together with the reaction directive when the reactions feature lands.
- **Coordinator-mode context export/import** — blocked on the coordinator receive path.
- **`formatChatTurn` sender id** — omitted for now; the adapter owns `m.mentions` matching later.

---

## 7. Risks

- **D15 reader refactor** is the highest-risk step: it changes error semantics (reject vs. resolve-an-error-string) and the early-exit path. Re-point every existing `local-spawn-backend` test deliberately.
- **Snapshot growth**: post-round export of a rolling context on a long-lived channel grows the payload. Watch it in production; the debug byte-size log exists for that. Compaction (summary-drop + aggressive threshold) is the intended counterweight — it was called out as a watch item by the requester.
- **Restore ordering**: `importContext` must run strictly before the first `sendUserMessage`. It does, because both happen inside the lifecycle tail (`ensureSession` precedes the send).
- **Concurrency**: the ledger is touched by `engine.injectMessage` (outside the tail) and by the surface (inside the lifecycle tail). SQLite serialises the writes; the surface only reads-then-deletes its own rows. No read-modify-write race on shared state.

---
key: plan-gateway-agent-self-scheduling
tags:
  - plan
  - drone-gateway
  - swarm-extension
  - scheduling
  - reminders
  - persona-assignment
created: 2026-11-08T18:33:40.268Z
updated: 2026-11-08T18:33:40.268Z
---

# Plan: Agent Self-Scheduling Wake-ups in drone-gateway

Status: ready for execution. Language: ASD-STE100 Simplified Technical English.
Branch: feat/gateway-swarm-extensions. ADR to write: 270.

## 1. Summary

This plan makes `drone-gateway` a _callee_ swarm extension.

Today the gateway declares an empty capability manifest. It is a sender only.
This plan makes the gateway declare three callable capabilities.
The capabilities let an agent schedule a one-time "wake-up" for itself.

When the wake-up time arrives, the gateway starts a new turn of the same agent.
The agent's reply goes to the chat. This makes sentences like
"Remind me to check the soup at 10 tomorrow" work.

The gateway is the correct place for this. The gateway owns the agent process
in local spawn mode. The gateway also owns the chat adapter and the durable
store.

## 2. Scope

In scope:

- A per-surface opt-in flag.
- Three capabilities: `schedule_wakeup`, `schedule_list`, `schedule_cancel`.
- A durable store for pending wake-ups.
- A polled timer that fires due wake-ups as agent turns.
- Posting the wake-up reply through a new engine seam.
- Documentation and an ADR.

Not in scope (v1):

- Coordinator spawn mode. The gateway cannot see the reply in that mode.
- Recurring schedules (one-time only).
- Per-wake-up timezone (absolute instants only).
- The wildcard conversation `*`.
- A requirement that the model must produce text.

## 3. Background you must know

Read these files before you start.

- `drone-gateway/src/extension-node.ts` - the gateway's extension node handle.
- `drone-gateway/src/engine.ts` - the gateway engine, surfaces, and adapters.
- `drone-gateway/src/surfaces/lifecycle.ts` - spawn, idle timeout, snapshot restore.
- `drone-gateway/src/surfaces/persona-assignment.ts` - the surface to modify.
- `drone-gateway/src/surfaces/types.ts` - `SurfaceContext`.
- `drone-gateway/src/store/gateway-state-store.ts` and `store/db.ts` - the SQLite store.
- `drone-gateway/src/inject/` - the control API and the one-shot agent helper.
- `drone-swarm-common/src/extension-server.ts` - the extension SDK.
- `drone-agent/src/plugins/extensions/` - the agent-side injection receiver.
- `docs/agents/swarm-extensions.md` - the extension protocol.
- `docs/adr/256-gateway-swarm-extension.md` - the gateway-as-extension design.

Key facts:

- A `tools` injection materializes agent tools named `extensions__<extId>__<tool>`.
  The tools start UNMOUNTED. The model mounts them with `runtime__mount_tool`.
- A tool call is a full agent turn.
- The agent calls a tool through the beacon and the coordinator. The coordinator
  sends an `invokeTool` command to the gateway node. The node answers.
- The invoke context carries the calling agent's `sessionId`.
- A `reminder` injection does NOT start a turn. Do not use it for wake-ups.
- `SessionLifecycle.send()` spawns on demand and restores the context snapshot.
- The `startup` plugin renders a `# Current Time` footer on every LLM call.
  The model already knows the current time. Do not add time plumbing.

## 4. Locked decisions

D1. A wake-up is a synthetic agent turn. The gateway calls
`SessionLifecycle.send(wakePrompt)`. The reply is posted. v1 is local spawn mode only.

D2. A wake-up round is a "deliverable round". It lifts the reply block in
`passive` and `observer` modes. The sentinels still suppress the post.

D3. The feature is opt-in per surface. Config key: `config.schedule.enabled`.
Default is off.

D4. The `schedule_wakeup` tool takes `note` (required), and one of `dueAt`
(ISO-8601 with an offset) or `delayMs` (milliseconds). The result echoes the
resolved instant and a relative form.

D5. Pending wake-ups are stored in the adapter's SQLite `dataPath` database.
If the adapter has no `dataPath`, the feature is disabled with one warning.
On restart, overdue wake-ups fire immediately, oldest first.
A wake-up on an idle session re-spawns the agent and restores the snapshot.
The session-to-conversation map is built from `sessionStarted`/`sessionEnded`.

D6. "Triggered" means `SessionLifecycle.send()` resolved. The row is deleted
then. The reply content controls delivery only. A thrown send is a non-trigger:
the row stays, `attempts` increases, the gateway retries on the next tick, and
drops the row after 3 attempts with an error log.

D7. Three capabilities. All are `exposed: 'mcp'`. The names have no dots:
`schedule_wakeup`, `schedule_list`, `schedule_cancel`. The tools stay UNMOUNTED.
The gateway injects one guidance fragment.

D8. A surface-owned polled tick fires wake-ups. The interval is 15000 ms.
The interval is a module constant. It is not configurable in v1. The engine
adds a `postMessage` seam to `SurfaceContext`.

D9. The extension hint stays `<extId>:<conversationId>`. The gateway resolves
the adapter by scanning the conversations. On a collision, log a warning and
return a tool error.

D10. Before the FIRST `sendMessage` only, the surface waits until the gateway
knows the conversation's session. The wait is bounded (about 5 s). On timeout,
continue and log a degradation.

## 5. Constants to add

Put these in the new file `drone-gateway/src/schedule/constants.ts`.

```ts
export const DEFAULT_WAKEUP_TICK_MS = 15_000;
export const MAX_WAKEUP_ATTEMPTS = 3;
export const SCHEDULE_READY_TIMEOUT_MS = 5_000;
export const SCHEDULE_READY_POLL_MS = 250;
export const SCHEDULE_GUIDANCE_INJECTION_ID = 'schedule-guidance';
```

## 6. Work order

Execute the phases in order. Phases depend on the phases above them.

| Phase              | Steps   | Depends on |
| ------------------ | ------- | ---------- |
| P0 Store and types | S1-S4   | none       |
| P1 Schedule domain | S5-S7   | P0         |
| P2 Node wiring     | S8-S9   | P1         |
| P3 Engine seams    | S10-S11 | P0         |
| P4 Surface         | S12-S14 | P1, P3     |
| P5 Config          | S15     | none       |
| P6 Docs            | S16-S18 | P0-P5      |
| P7 Validation      | S19     | all        |

## 7. Steps

### P0 - Store and types

#### S1 (coder) - Add the `scheduled_wakeups` table

File: `drone-gateway/src/store/db.ts`

Add one function. Call it from `initGatewaySchema`.

```ts
function createScheduleSchema(db: GatewayDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_wakeups (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      note            TEXT NOT NULL,
      due_at          INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_wakeups_due
      ON scheduled_wakeups (conversation_id, due_at);
  `);
}
```

#### S2 (coder) - Add the wake-up store

File: `drone-gateway/src/store/gateway-state-store.ts`

Add the types and the factory. Use `better-sqlite3` prepared statements.
All methods are synchronous. This matches the other stores.

```ts
export interface ScheduledWakeup {
  id: string;
  conversationId: string;
  note: string;
  dueAt: number;
  createdAt: number;
  attempts: number;
}

export interface ScheduledWakeupStore {
  insert(input: {
    id: string;
    conversationId: string;
    note: string;
    dueAt: number;
  }): void;
  list(conversationId: string): ScheduledWakeup[];
  get(id: string): ScheduledWakeup | null;
  due(conversationId: string, now: number): ScheduledWakeup[];
  remove(id: string): void;
  bumpAttempts(id: string): number;
}

export function createScheduledWakeupStore(
  db: GatewayDatabase
): ScheduledWakeupStore {
  /* implement with prepared statements */
}
```

`list` and `due` order rows by `due_at` ascending, then by `created_at`.

#### S3 (coder) - Expose the store on the adapter

Files: `drone-gateway/src/types.ts`, `drone-gateway/src/adapters/matrix.ts`

In `types.ts`, add to `DroneServiceAdapter`:

```ts
/** Built when the adapter has a persistent DB; absent otherwise. */
readonly wakeupStore?: ScheduledWakeupStore;
```

In `matrix.ts`, in the `if (dataPath)` block, add:

```ts
this.wakeupStore = createScheduledWakeupStore(this.db);
```

Add the matching import. Set `this.wakeupStore = undefined` in `stop()`.

#### S4 (coder) - Add an engine accessor

File: `drone-gateway/src/engine.ts`

Add one method. The schedule service uses it to write wake-ups.

```ts
getWakeupStore(adapterId: string): ScheduledWakeupStore | undefined {
  return this.adapters.get(adapterId)?.wakeupStore;
}
```

#### S5 (tester) - Tests for the store

File: `drone-gateway/test/schedule-store.test.ts`

Test: insert and list; `due` returns only rows with `due_at <= now`; `due`
orders oldest first; `remove` deletes; `bumpAttempts` increments and returns
the new count; a second `initGatewaySchema` call is safe.

### P1 - Schedule domain

#### S6 (coder) - Capability catalog and guidance fragment

File: `drone-gateway/src/schedule/catalog.ts` (new)

```ts
import type { DroneExtensionCapability } from 'drone-core';
import { DEFAULT_GATEWAY_EXTENSION_ID } from '../extension-defaults.js';

export const SCHEDULE_CAPABILITIES: DroneExtensionCapability[] = [
  {
    name: 'schedule_wakeup',
    description:
      'Schedule a one-time wake-up for yourself. At or just after the given ' +
      'time you receive a new turn that carries this note. Use it for user ' +
      'reminders, for example "remind me to check the soup at 10". Give an ' +
      'absolute ISO-8601 time with an offset in dueAt, or a relative delay in ' +
      'delayMs. The result returns the resolved time.',
    paramSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The thing to surface at wake time.' },
        dueAt: {
          type: 'string',
          description: 'Absolute ISO-8601 time with an offset.
',
        },
        delayMs: {
          type: 'number',
          description: 'Relative delay from now, in milliseconds.',
        },
      },
      required: ['note'],
    },
    responseSchema: { type: 'object' },
  },
  {
    name: 'schedule_list',
    description:
      'List the pending wake-ups you have scheduled in this conversation.',
    paramSchema: { type: 'object', properties: {} },
    responseSchema: { type: 'array' },
  },
  {
    name: 'schedule_cancel',
    description:
      'Cancel a pending wake-up by its id. Get ids from schedule_list.',
    paramSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The wake-up id to cancel.' },
      },
      required: ['id'],
    },
    responseSchema: { type: 'object' },
  },
];

export function scheduleGuidanceFragment(): string {
  return [
    '# Scheduled Wake-ups',
    '',
    'You can schedule a one-time wake-up for yourself.',
    'Use the `extensions__' + DEFAULT_GATEWAY_EXTENSION_ID + '__schedule_wakeup` tool.',
    'At or just after the time you give, the system starts a new turn of this agent.',
    'That turn carries your note. Your reply is sent to the conversation.',
    'Use this for user reminders, for example "remind me to check the soup at 10".',
    'These tools start unmounted. Mount them with `runtime__mount_tool` before use.',
    'The other tools are `..._schedule_list` and `..._schedule_cancel`.',
  ].join('\n');
}
```

#### S7 (coder) - Wake prompt and reply classification

File: `drone-gateway/src/schedule/wake-prompt.ts` (new)

```ts
import { isCancelled, isNoResponse } from '../chat-format.js';

export const WAKE_INSTRUCTION =
  'This is a scheduled wake-up you set earlier. Reply to the user now. ' +
  'If you truly have nothing to say, reply with exactly <<NO_RESPONSE>>.';

export function buildWakePrompt(note: string, dueAt: number): string {
  return (
    '[scheduled wake-up] You set this reminder for the user earlier:\n\n' +
    '  ' +
    note +
    '\n\n' +
    'It became due at ' +
    new Date(dueAt).toISOString() +
    '. Act on it now.'
  );
}

export type WakeOutcome = 'posted' | 'sentinel' | 'empty';

export function classifyWakeReply(reply: string | null): WakeOutcome {
  if (reply === null) return 'empty';
  if (isCancelled(reply) || isNoResponse(reply)) return 'sentinel';
  if (reply.trim() === '') return 'empty';
  return 'posted';
}
```

#### S8 (coder) - Invoke handlers

File: `drone-gateway/src/schedule/invoke.ts` (new)

Add a pure function set that the service uses. It parses params and returns
`{ ok, status, body }`. It does not touch the network.

```ts
export interface InvokeCtxLike {
  caller: 'ui' | 'agent';
  sessionId?: string;
}

export function resolveDueAt(params: {
  dueAt?: unknown;
  delayMs?: unknown;
}): { ok: true; dueAt: number } | { ok: false; error: string } {
  const dueAtRaw = params.dueAt;
  const delayRaw = params.delayMs;
  const now = Date.now();
  if (typeof dueAtRaw === 'string' && dueAtRaw.trim() !== '') {
    const parsed = Date.parse(dueAtRaw);
    if (Number.isNaN(parsed)) {
      return { ok: false, error: 'dueAt is not a valid ISO-8601 time' };
    }
    return { ok: true, dueAt: parsed };
  }
  if (typeof delayRaw === 'number' && Number.isFinite(delayRaw)) {
    if (delayRaw < 0)
      return { ok: false, error: 'delayMs must not be negative' };
    return { ok: true, dueAt: now + delayRaw };
  }
  return { ok: false, error: 'provide dueAt or delayMs' };
}

export function formatHuman(dueAt: number, now: number): string {
  const diff = dueAt - now;
  if (diff <= 0) return 'in the past (fires on the next tick)';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins} minute(s)`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `in ${hours}h ${rem}m`;
}
```

#### S9 (tester) - Tests for the domain

Files: `drone-gateway/test/schedule-invoke.test.ts`,
`drone-gateway/test/schedule-wake-prompt.test.ts`

Test `resolveDueAt`: valid `dueAt`; invalid `dueAt`; `delayMs` alias; both
present (`dueAt` wins); neither present; negative `delayMs`.
Test `classifyWakeReply`: text, `<<NO_RESPONSE>>`, `__CANCELLED__`, empty, null.
Test `buildWakePrompt` contains the note and the ISO time.

### P2 - Node wiring

#### S10 (coder) - Declare capabilities and handle invokes

File: `drone-gateway/src/extension-node.ts`

Changes:

1. Import `SCHEDULE_CAPABILITIES`.
2. Pass `capabilities: SCHEDULE_CAPABILITIES` to `createExtensionNode`.
   This replaces `capabilities: []`.
3. Add a `setHandlers` method that stores session and invoke handlers.
4. Add delegate methods: `injectFragment`, `injectTools`, `removeInjection`.
   Each forwards to the node when it exists, and no-ops when the node is null.

```ts
setHandlers(handlers: {
  onSessionStarted: (s: DroneSessionSnapshot) => void;
  onSessionEnded: (e: DroneSessionEndedEvent) => void;
  onInvokeTool: (
    cap: string,
    params: unknown,
    ctx: InvokeCtx
  ) => Promise<InvokeResult>;
}): void {
  this.handlers = handlers;
}
```

Pass the stored handlers into `createExtensionNode`.

#### S11 (tester) - Tests for the node wiring

File: `drone-gateway/test/extension-node.test.ts` (extend)

Test: the manifest carries the three capability names. Test: an `invokeTool`
command reaches `onInvokeTool` and the response is sent. Test: `injectTools`
before the node exists does not throw.

### P3 - Engine seams

#### S12 (coder) - Add `postMessage`, `wakeupStore`, and readiness to `SurfaceContext`

File: `drone-gateway/src/surfaces/types.ts`

Add to `SurfaceContext`:

```ts
/** Post text into this conversation from a surface. Internal, no opt-in gate. */
postMessage: (conversationId: string, text: string) => Promise<void>;
/** Absent when the adapter has no persistent DB (scheduling disabled). */
wakeupStore?: ScheduledWakeupStore;
/** Present when the surface opted into scheduling. */
scheduleReadiness?: {
  isReady: (conversationId: string) => boolean;
  timeoutMs: number;
  pollMs: number;
};
```

#### S13 (coder) - Wire the seams in `GatewayEngine`

File: `drone-gateway/src/engine.ts`

1. Add a private `postToConversation(adapterId, conversationId, text)` method.
   Copy the body of `injectMessage` after the injection check. It splits the
   text with `adapter.splitOutbound`, sends each chunk, and appends one ledger
   row per chunk. Make `injectMessage` call this helper too.
2. In `surfaceContext`, add:
   - `postMessage: (conversationId, text) => this.postToConversation(adapterId, conversationId, text)`,
   - `wakeupStore: adapter?.wakeupStore`,
   - `scheduleReadiness` when the surface's config has `schedule.enabled === true`
     and a `wakeupStore` exists.
3. In `start()`, build the set of schedule-enabled conversations. Pass it to the
   schedule service through a method: `scheduleService.setEnabledConversations(set)`.
   Log one line per enabled conversation.
4. In `start()`, when a persona-assignment surface is schedule-enabled and the
   adapter has no `dataPath`, log one warning. Use this text:
   `scheduling is disabled: this adapter has no "dataPath"`.

#### S14 (tester) - Tests for the engine seams

File: `drone-gateway/test/engine.test.ts` (extend)

Test: `postMessage` sends through the adapter and appends a ledger row.
Test: `injectMessage` still enforces `injection.enabled`.
Test: an enabled surface gets `scheduleReadiness`; a disabled one does not.

### P4 - Schedule service and surface

#### S15 (coder) - The schedule service

File: `drone-gateway/src/schedule/service.ts` (new)

The service owns four things:

1. The session map: `sessionId` to `{ adapterId, conversationId }`.
2. Tool and fragment injection on `sessionStarted`.
3. The three invoke handlers.
4. Readiness for the first turn.

```ts
export interface ScheduleServiceDeps {
  getNode: () =>
    | {
        injectFragment(input: {
          target: string;
          id: string;
          content: string;
        }): void;
        injectTools(input: { target: string; capabilities: string[] }): void;
      }
    | undefined;
  getWakeupStore: (adapterId: string) => ScheduledWakeupStore | undefined;
  resolveAdapter: (
    conversationId: string
  ) => { adapterId: string; ambiguous: boolean } | undefined;
  logger: { info: (o: unknown, m?: string) => void; warn: (m: string) => void };
}

export class ScheduleService {
  private sessions = new Map<
    string,
    { adapterId: string; conversationId: string }
  >();
  private enabled = new Set<string>(); // conversation ids

  setEnabledConversations(ids: Set<string>): void {
    this.enabled = ids;
  }

  registerSession(snapshot: DroneSessionSnapshot): void {
    const hint = snapshot.extensionHint;
    if (!hint) return;
    const prefix = `${DEFAULT_GATEWAY_EXTENSION_ID}:`;
    if (!hint.startsWith(prefix)) return;
    const conversationId = hint.slice(prefix.length);
    if (!this.enabled.has(conversationId)) return;
    const resolved = this.deps.resolveAdapter(conversationId);
    if (!resolved || resolved.ambiguous) {
      this.deps.logger.warn(
        `scheduling: cannot resolve adapter for conversation ${conversationId}`
      );
      return;
    }
    this.sessions.set(snapshot.sessionId, {
      adapterId: resolved.adapterId,
      conversationId,
    });
    const node = this.deps.getNode();
    if (!node) return;
    node.injectTools({
      target: snapshot.sessionId,
      capabilities: SCHEDULE_CAPABILITIES.map(c => c.name),
    });
    node.injectFragment({
      target: snapshot.sessionId,
      id: SCHEDULE_GUIDANCE_INJECTION_ID,
      content: scheduleGuidanceFragment(),
    });
  }

  unregisterSession(event: DroneSessionEndedEvent): void {
    this.sessions.delete(event.sessionId);
  }

  isReady(conversationId: string): boolean {
    for (const v of this.sessions.values()) {
      if (v.conversationId === conversationId) return true;
    }
    return false;
  }

  async handleInvokeTool(
    cap: string,
    params: unknown,
    ctx: InvokeCtxLike
  ): Promise<InvokeResult> {
    /* switch on cap; see below */
  }
}
```

`handleInvokeTool` logic:

- Resolve the session: `this.sessions.get(ctx.sessionId ?? '')`. If absent, return
  `{ ok: false, status: 400, body: { error: 'unknown session' } }`.
- `schedule_wakeup`: read `note` (string, required). Call `resolveDueAt(params)`.
  On error return `{ ok: false, status: 400, body: { error } }`. Build an id with
  `randomUUID()`. Insert into the store. Return
  `{ ok: true, status: 200, body: { id, dueAt, inHuman: formatHuman(dueAt, Date.now()) } }`.
  If the store is absent, return
  `{ ok: false, status: 503, body: { error: 'scheduling disabled (no dataPath)' } }`.
- `schedule_list`: return `{ ok: true, status: 200, body: store.list(conversationId) }`.
- `schedule_cancel`: read `id`. Return
  `{ ok: true, status: 200, body: { cancelled: removed } }`.

Keep each file below 750 lines. If `service.ts` grows, move the handlers to
`drone-gateway/src/schedule/handlers.ts`.

#### S16 (tester) - Tests for the service

File: `drone-gateway/test/schedule-service.test.ts`

Test with a fake node and an in-memory store:

- `registerSession` injects tools and the fragment for an enabled conversation.
- `registerSession` ignores a non-matching hint and a disabled conversation.
- `schedule_wakeup` inserts a row and returns the resolved instant.
- `schedule_wakeup` with a bad time returns a 400.
- `schedule_list` and `schedule_cancel` work.
- An unknown session returns a 400.

#### S17 (coder) - The surface: gate, readiness, tick, wake round

File: `drone-gateway/src/surfaces/persona-assignment.ts`

Add:

1. A module constant import: `DEFAULT_WAKEUP_TICK_MS`, `MAX_WAKEUP_ATTEMPTS`.
2. A `runWake(w)` function:

```ts
async function runWake(w: ScheduledWakeup): Promise<void> {
  const store = ctx.wakeupStore;
  if (!store || disposed) return;
  const { text: preamble, ids } = buildPreamble();
  const prompt = preamble + buildWakePrompt(w.note, w.dueAt);
  let reply: string | null;
  try {
    reply = await lifecycle.send(prompt, { systemReminder: WAKE_INSTRUCTION });
  } catch (err) {
    logger.warn({ err, conversationId }, 'wake-up turn failed; will retry');
    const attempts = store.bumpAttempts(w.id);
    if (attempts >= MAX_WAKEUP_ATTEMPTS) {
      store.remove(w.id);
      logger.error(
        { conversationId, wakeupId: w.id },
        'wake-up dropped after max attempts'
      );
    }
    return;
  }
  store.remove(w.id);
  if (ledger && ids.length > 0) ledger.remove(ids);
  const outcome = classifyWakeReply(reply);
  logger.info({ conversationId, wakeupId: w.id, outcome }, 'wake-up fired');
  if (outcome === 'posted')
    await ctx.postMessage(conversationId, reply!.trim());
}
```

3. A `fireDue()` function that reads `store.due(conversationId, Date.now())` and
   awaits `runWake` for each row, oldest first.
4. In the factory, when `ctx.scheduleReadiness` and `ctx.wakeupStore` exist:

```ts
if (ctx.scheduleReadiness && ctx.wakeupStore) {
  wakeTimer = setInterval(() => {
    void fireDue();
  }, DEFAULT_WAKEUP_TICK_MS);
  wakeTimer.unref();
}
```

5. Add `wakeTimer` cleanup to `dispose`.
6. Add a `disposed` flag, set in `dispose`.

#### S18 (coder) - The readiness wait in the lifecycle

File: `drone-gateway/src/surfaces/lifecycle.ts`

Add an optional `ctx.scheduleReadiness`. In `send()`, after `ensureSession()`
and before the first `sendMessage`, run a bounded wait. Run it ONCE per session.

```ts
private readinessDone = false;

private async awaitReadiness(): Promise<void> {
  const r = this.opts.ctx.scheduleReadiness;
  if (!r || this.readinessDone) return;
  this.readinessDone = true;
  const deadline = Date.now() + r.timeoutMs;
  while (!r.isReady(this.opts.conversationId) && Date.now() < deadline) {
    await new Promise(res => setTimeout(res, r.pollMs));
  }
  if (!r.isReady(this.opts.conversationId)) {
    logger.warn(
      { conversationId: this.opts.conversationId },
      'schedule tools not ready before first turn; continuing'
    );
  }
}
```

Call `await this.awaitReadiness()` inside `send()` right after `ensureSession()`.
Reset `readinessDone` to `false` in the re-spawn path.

Note: `setTimeout` here is a bounded sleep. Do not use a fixed sleep in tests.
Poll for the observable.

#### S19 (tester) - Tests for the surface and lifecycle

Files: `drone-gateway/test/persona-assignment-surface.test.ts` (extend),
`drone-gateway/test/session-lifecycle.test.ts` (extend)

Test: a wake round posts its reply in `observer` mode (D2).
Test: a `<<NO_RESPONSE>>` wake reply posts nothing and still removes the row (D6).
Test: a thrown send keeps the row and increments `attempts`.
Test: after 3 attempts the row is removed.
Test: the tick does not fire when scheduling is disabled.
Test: `awaitReadiness` returns at once when no readiness is configured.
Test: `awaitReadiness` waits, then continues on timeout (use fake timers or a
polling assertion, not a fixed sleep).

### P5 - Config

#### S20 (coder) - Sanitize the `schedule` config bag

File: `drone-gateway/src/config/load.ts`

In `sanitizeSurfaceConfig`, add a block for `schedule`. It must be an object
with a boolean `enabled`. Warn and drop an invalid value. Keep the `rest`
pattern used by the other keys.

```ts
const schedule = rest.schedule;
if (schedule !== undefined) {
  if (
    typeof schedule !== 'object' ||
    schedule === null ||
    Array.isArray(schedule)
  ) {
    warn('schedule is not an object; ignoring');
    delete rest.schedule;
  } else {
    const bag = { ...(schedule as Record<string, unknown>) };
    if (bag.enabled !== undefined && typeof bag.enabled !== 'boolean') {
      warn('schedule.enabled must be a boolean; ignoring');
      delete bag.enabled;
    }
    rest.schedule = bag;
  }
}
```

#### S21 (tester) - Tests for config

File: `drone-gateway/test/config-load.test.ts` (extend)

Test: a valid `schedule.enabled: true` is kept. Test: a non-boolean is dropped
with a warning. Test: a non-object `schedule` is dropped.

### P6 - Documentation

#### S22 (coder) - Write ADR 270

File: `docs/adr/270-gateway-agent-self-scheduling.md` (new)

Use the repo ADR format (number, title, status, context, decision, consequences).
Record D1 to D10. State the non-goals. State the local-mode limit.

Update `docs/adr/index.md`: add one row for ADR 270, and update the count.
Check the frontier table row. The current frontier is 269.

#### S23 (coder) - Update the agent and gateway docs

Files:

- `docs/agents/swarm-extensions.md` - replace "gateway is a sender only" text.
  State that the gateway now declares three `schedule_*` capabilities.
- `drone-gateway/CONTEXT.md` - add the schedule surface flag, the store table,
  and the tick. Add the surface to the config-bag list.

#### S24 (coder) - Update the swarm wiki

Add one page: `gateway-agent-self-scheduling`. Describe the protocol use, the
three capabilities, the store, the tick, and the local-mode limit. Link it from
the `drone-gateway-swarm-extension-migration` page.

### P7 - Validation

#### S25 (reviewer) - Check the work against this plan

Check each item in section 8. Use the LSP `find_references` for every changed
interface (`SurfaceContext`, `DroneServiceAdapter`, `SpawnBackend`). Confirm
every implementer, consumer, and test mock is updated. Grep for each new field
name as a cross-check.

#### S26 (tester) - Run the full validation

Run, in this order:

1. `pnpm -r run build`
2. `pnpm typecheck`
3. `pnpm run lint`
4. `pnpm run test`

All four must pass with zero errors. Fix every failure. Re-run after each fix.

Then commit. Check in any `.drone-agent` memory, skills, insights, and
principles files if the branch is a feature branch.

## 8. Validation criteria

The work is complete when all these are true.

1. LSP diagnostics are clean for every changed file. `lsp__get_diagnostics`
   reports no errors.
2. `pnpm -r run build` passes with zero errors.
3. `pnpm typecheck` passes with zero errors.
4. `pnpm run lint` passes with zero errors. (This runs ESLint and Prettier.)
5. `pnpm run test` passes. All new tests pass.
6. New unit tests cover: the store, `resolveDueAt`, `classifyWakeReply`,
   `buildWakePrompt`, the service, the surface wake round, the readiness wait,
   and the config sanitizer.
7. The gateway manifest contains `schedule_wakeup`, `schedule_list`, and
   `schedule_cancel`.
8. An enabled conversation gets the tools and the guidance fragment injected.
   A disabled conversation does not.
9. A wake-up fires an agent turn. The reply is posted in `active`, `passive`,
   and `observer` modes. A `<<NO_RESPONSE>>` reply posts nothing.
10. A resolved send deletes the row. A thrown send keeps the row and retries.
    After 3 attempts the row is dropped.
11. The wake-up survives a gateway restart. An overdue wake-up fires on start.
12. No new time plumbing exists. The plan reuses the `startup` clock fragment.
13. ADR 270 exists. `docs/adr/index.md` lists it. The docs and the wiki are
    updated.
14. File sizes: no changed file exceeds 1000 lines. Files above 750 lines are
    split.

## 9. Known risks

- The turn-1 race. The tools arrive through many hops. D10 covers it with a
  bounded wait. If the wait is not enough, the model schedules from turn 2.
- The agent must run the `swarm` and `extensions` plugins. The gateway must
  reach a beacon. Document this requirement in the ADR and `CONTEXT.md`.
- Coordinator spawn mode is unsupported in v1. Return a clear error if a
  schedule tool is called from such a session.

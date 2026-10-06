---
key: plan-gateway-chat-tagging-batching-optout
tags:
  - plan
  - drone-gateway
  - drone-agent
  - chat
  - tagging
  - batching
  - control-surface
  - spawn-backend
  - multi-user
created: 2026-10-05T20:20:00.000Z
updated: 2026-10-05T20:20:00.000Z
---

# Plan: Gateway chat tagging + drain-on-idle batching + multi-user response opt-out

**Branch to create:** `feat/gateway-chat-tagging-batching-optout`, branched from the current
`feat/gateway-surface-lifecycle-and-workdir` tip (`ff030dc7`).
**Base dependency:** ADR 232 (surface lifecycle + per-surface `workingDir` + per-conversation
serialization) is already committed on that branch. This plan builds directly on it.

## 1. What and why

The gateway forwards each inbound chat message to a spawned agent **unlabelled** and **one
message at a time**. Three gaps:

1. **No speaker attribution.** The Matrix adapter already computes `senderName` and attaches
   `senderId`/`senderName` to `AdapterMessage`, but `persona-assignment` forwards only
   `msg.text`, so the speaker is dropped. In a room (any group of 3+), all allowed senders
   share **one** agent session, so the agent sees an unlabelled stream and cannot tell who
   said what. This got worse when ADR 232 added idle re-spawn: a re-spawned agent has no
   accumulated history to infer speakers from.
2. **No batching.** A message that arrives while a turn is in flight is queued by the engine's
   `runOnTail`, so it becomes its **own full LLM turn**. A burst of N messages while busy costs
   N turns.
3. **No way to decline to answer.** In a multi-user room the bot answers every message. There
   is no way to tell the model "decide whether a reply is needed" and no way for it to stay
   silent.

**Also folded in (precondition, agreed):** the coordinator-mode send path is **dead**.
`CoordinatorSpawnBackend.sendMessage` → `CoordinatorClient.sendMessage` posts
`/api/messages/relay` with only `{toAgentId, body}`, but the route requires `fromBeaconId` and
`fromAgentId` → a guaranteed **400 at the first hop**. The **send half** is fixed here so the
feature is not local-only. The **receive half** (the gateway has no WebSocket client, and
`sendSessionMessage` returns a delivery ack, not a reply) is **deferred to a separate plan**.

## 2. Locked decisions (all explicit)

| # | Decision |
|---|----------|
| D1 | **Tag seam.** Tagging happens in the **surface** (`persona-assignment`), via a shared gateway helper. The engine, `swarm-console`, and `discard` are untouched — `swarm-console` must still see raw `swarm.` lines. |
| D2 | **Tag format.** Bracketed prefix: `[Alice] fix the build`. Fallback chain `senderName → senderId → 'unknown'`. Applied in **rooms and DMs** (always on, no toggle). Multi-line messages: only the first line is prefixed. |
| D3 | **Room detection.** `AdapterMessage` gains `conversationKind: 'dm' \| 'room'`. The Matrix adapter sets it from `isDM` (`joinedCount <= 2`). The gateway never inspects `conversationId`. |
| D4 | **Batching model = drain-on-idle + debounce.** Every incoming message is appended to the conversation's buffer and the flush timer is (re)armed for `debounceMs`. When it fires, the buffer is drained and dispatched as **one** turn through `runOnTail` (so it waits behind any in-flight turn). One merged reply per batch. |
| D5 | **Batching opt-in = structural.** A new optional `DroneControlSurface.handleBatch(messages)`. Its **presence** is the opt-in. `persona-assignment` implements it; `swarm-console`/`discard` do not. There is **no disable flag**. |
| D6 | **Batching eligibility = exact match + exactly one surface.** A conversation is batched only when the message resolves to an **exact** conversation, the sender is allowed, and that conversation has **exactly one** surface, which defines `handleBatch`. Otherwise today's immediate per-message path runs (wildcard included). |
| D7 | **Merge format.** Buffered turns joined by newline; each is already `[Name]`-tagged, so the tags delimit. No extra separator. |
| D8 | **Debounce config.** Surface `controlSurfaces[].config.batch.debounceMs` ?? gateway-wide top-level `batch.debounceMs` ?? **500 ms**. `0` disables the debounce (flush on the next tick). Loader sanitization mirrors `sanitizeIdleTimeoutMs` (finite, non-negative; warn-and-drop). |
| D9 | **Silence = sentinel.** The gateway owns `NO_RESPONSE_SENTINEL = '<<NO_RESPONSE>>'` and the room instruction text. The surface checks the reply with **exact match modulo trim**: `reply.trim() === NO_RESPONSE_SENTINEL` → return `{ response: null, handled: true }` (engine posts nothing). Checked **unconditionally** (rooms and DMs). Logged distinctly. |
| D10 | **Room instruction delivery.** Gateway-owned text, sent **per turn** as a new optional `systemReminder` field on the turn payload. The agent queues it via `_runtime.queueSystemReminder(...)`, drained as a **non-persisted** `role:'user'` `<system-reminder>`. Not persisted, so it neither accumulates nor survives a re-spawn as stale text. |
| D11 | **Coordinator send-half fix (in scope).** `CoordinatorSpawnBackend.sendMessage` delivers a real user turn via `CoordinatorClient.sendSessionMessage(processId, text, false)` (the path the coordinator UI uses), **not** the relay. Because there is no receive path, it returns **`null`** = "no synchronous reply"; the surface treats `null` as "post nothing". The dead relay client method is removed. |
| D12 | **Coordinator receive half + `systemReminder` over the coordinator path — DEFERRED.** A separate plan will add a gateway-side WS subscription to the coordinator `/ws` (`subscribe {sessionId}`) to resolve replies. `systemReminder` is **local-only** in this plan. |

### Deferred / out of scope
- **Coordinator receive path** (making coordinator-mode `persona-assignment` functional end-to-end). Separate plan.
- **`systemReminder` over the coordinator transport** (rides with the above).
- **Batching in mixed-surface conversations** (`[swarm-console, persona-assignment]`). Seed saved: project memory `planning-seed-mixed-conversation-batching`.
- **Per-sender session isolation** (only tagging is in scope).
- **A silence *tool*** (`chat__stay_silent`) — rejected in favour of the sentinel.

## 3. The room instruction (for review at sign-off)

Delivered as the per-turn `systemReminder` **only when `conversationKind === 'room'`**:

```
You are participating in a group chat with multiple people. Each incoming message is
tagged with the sender's name in square brackets, for example "[Alice] hello". People
often address each other rather than you. Before answering, decide whether a reply is
actually warranted — answer only if you have something useful to contribute, or if you
are directly addressed. If no response is warranted, reply with exactly <<NO_RESPONSE>>
and nothing else; your reply will not be sent.
```

> **REVIEW THIS TEXT.** It is the user-facing prompt; adjust wording before execution if desired.

## 4. Files touched

**drone-gateway**
- `src/types.ts` — `AdapterMessage.conversationKind`; `DroneControlSurface.handleBatch?`
- `src/spawn-backend.ts` — `sendMessage(session, message, opts?)` → `Promise<string | null>`
- `src/surfaces/types.ts` — `SurfaceContext.debounceMs?`
- `src/chat-format.ts` **(new)** — `formatChatTurn`, `NO_RESPONSE_SENTINEL`, `ROOM_INSTRUCTION`, `isNoResponse`
- `src/batcher.ts` **(new)** — `MessageBatcher`
- `src/surfaces/lifecycle.ts` — thread `sendMessage` opts; accept a `null` reply
- `src/surfaces/persona-assignment.ts` — `handleMessage` + `handleBatch`
- `src/local-spawn-backend.ts` — include `systemReminder` in the NDJSON chat event
- `src/coordinator-spawn-backend.ts` — send-half fix; return `null`
- `src/coordinator-client.ts` — remove the dead `sendMessage` (relay) method
- `src/engine.ts` — batcher wiring; `surfaceContext` gains `debounceMs`; `stop()` clears batchers
- `src/config/load.ts` — sanitize `batch.debounceMs` (surface) + top-level `batch.debounceMs`
- `CONTEXT.md`; `docs/adr/006-chat-tagging-batching-optout.md` **(new)**
- Tests: `test/batcher.test.ts` **(new)**, `test/chat-format.test.ts` **(new)**; updates to `test/engine.test.ts`, `test/surfaces/persona-assignment-surface.test.ts`, `test/session-lifecycle.test.ts`, `test/local-spawn-backend.test.ts`, `test/coordinator-spawn-backend.test.ts`, `test/coordinator-client.test.ts`, `test/config-load.test.ts`, `test/swarm-console-surface.test.ts`

**drone-agent**
- `src/interactive.ts` — `InputEvent` chat variant gains `systemReminder?`; `runJsonListenMode` queues it
- `src/runtime/plugin-engine.ts` — add public `queueSystemReminder(content)`
- Tests: `test/interactive-listen-notices.test.ts` (or the json-listen suite); `test/plugin-engine.test.ts`

## 5. Step-by-step plan

Each step is atomic and independently testable. Agent types: **coder**, **tester**, **reviewer**.
Execute top to bottom; "Depends on" lists blockers.

---

### S1 — (coder) `AdapterMessage.conversationKind` + surface/mock sweep
**Depends on:** nothing.

In `drone-gateway/src/types.ts`, extend `AdapterMessage`:

```ts
export interface AdapterMessage {
  adapterId: string;
  conversationId: string;
  text: string;
  senderId?: string;
  senderName?: string;
  /**
   * Whether this conversation is a 1:1 DM or a multi-user room. Computed by the
   * adapter (it owns conversation routing); the gateway never inspects the id.
   */
  conversationKind: 'dm' | 'room';
}
```

In `drone-gateway/src/adapters/matrix.ts`, at the emit site (~line 262), set it from `isDM`:

```ts
this.msgHandler?.({
  adapterId: this.id,
  conversationId,
  text: body,
  senderId: sender,
  senderName,
  conversationKind: isDM ? 'dm' : 'room',
});
```

Then **sweep every `AdapterMessage` literal**: grep `senderId:` and `conversationId:` across
`drone-gateway/src` and `drone-gateway/test`. Add `conversationKind` to each producer and test
fixture. (Belt-and-suspenders: `grep -rn "AdapterMessage" drone-gateway`.)

### S2 — (tester) `conversationKind` cases
**Depends on:** S1.

In `test/matrix-adapter.test.ts`: assert a room event yields `conversationKind: 'room'` and a
2-member event yields `'dm'`. Update every `AdapterMessage` fixture in the gateway test suite
to include the field. The build gate enforces completeness.

### S3 — (coder) Gateway chat-format helper + sentinel
**Depends on:** nothing.

New `drone-gateway/src/chat-format.ts`:

```ts
/** The exact reply an agent sends to decline to respond. */
export const NO_RESPONSE_SENTINEL = '<<NO_RESPONSE>>';

/** The per-turn instruction injected into multi-user room conversations. */
export const ROOM_INSTRUCTION =
  'You are participating in a group chat with multiple people. Each incoming message is\n' +
  'tagged with the sender\'s name in square brackets, for example "[Alice] hello". People\n' +
  'often address each other rather than you. Before answering, decide whether a reply is\n' +
  'actually warranted — answer only if you have something useful to contribute, or if you\n' +
  'are directly addressed. If no response is warranted, reply with exactly <<NO_RESPONSE>>\n' +
  'and nothing else; your reply will not be sent.';

/** True when a reply is the decline-to-respond sentinel. Exact match modulo trim. */
export function isNoResponse(reply: string): boolean {
  return reply.trim() === NO_RESPONSE_SENTINEL;
}

/**
 * Tag a single inbound turn with the speaker's name: `[Alice] fix the build`.
 * Falls back senderName → senderId → 'unknown'. Only the first line is prefixed.
 */
export function formatChatTurn(msg: Pick<AdapterMessage, 'senderName' | 'senderId' | 'text'>): string {
  const name = msg.senderName?.trim() || msg.senderId?.trim() || 'unknown';
  return `[${name}] ${msg.text}`;
}
```
(Import `AdapterMessage` as a type.)

### S4 — (tester) chat-format tests
**Depends on:** S3.

New `test/chat-format.test.ts`: `formatChatTurn` prefixes with `senderName`; falls back to
`senderId` then `'unknown'`; only prefixes the first line of a multi-line message;
`isNoResponse('  <<NO_RESPONSE>>  ')` is true; `isNoResponse('<<NO_RESPONSE>> but more')` is
false; `NO_RESPONSE_SENTINEL` is the exact literal.

---

### S5 — (coder) Widen `SpawnBackend.sendMessage` (opts + nullable reply)
**Depends on:** nothing.

In `drone-gateway/src/spawn-backend.ts`:

```ts
export interface SendMessageOptions {
  /**
   * A non-persisted system instruction to deliver with this turn. The agent
   * queues it as a system reminder (never entered into session history).
   */
  systemReminder?: string;
}

/** ... */
sendMessage(
  session: SpawnSession,
  message: string,
  opts?: SendMessageOptions
): Promise<string | null>;   // null = "no synchronous reply available"
```

Document: `null` means the backend cannot supply a reply (used by coordinator mode until the
receive path lands). The surface must post nothing for `null`.

### S6 — (coder) `LocalSpawnBackend`: deliver `systemReminder`
**Depends on:** S5.

In `drone-gateway/src/local-spawn-backend.ts`, `sendMessage` gains the `opts` param and writes
it into the NDJSON chat event:

```ts
const chatEvent =
  JSON.stringify({
    type: 'chat',
    message,
    ...(opts?.systemReminder ? { systemReminder: opts.systemReminder } : {}),
  }) + '\n';
```

Return type becomes `Promise<string | null>` (it always returns the (possibly empty) string —
local mode does not use `null`).

### S7 — (coder) `CoordinatorSpawnBackend`: send-half fix + `null` reply
**Depends on:** S5.

In `drone-gateway/src/coordinator-spawn-backend.ts`, replace the relay call:

```ts
async sendMessage(session: SpawnSession, message: string): Promise<string | null> {
  logger.info(`Sending message to agent ${session.processId} via coordinator`);
  // The receive path is not implemented yet (no gateway WS subscription), so we
  // can only deliver the turn; there is no synchronous reply. Return null so the
  // surface posts nothing instead of posting the delivery ack as the reply.
  await this.coordinatorClient.sendSessionMessage(session.processId, message, false);
  return null;
}
```

In `drone-gateway/src/coordinator-client.ts`, **remove** the now-dead `sendMessage` (relay)
method. Verify first with `grep -rn "\.sendMessage(" drone-gateway/src` that the only gateway
caller was the coordinator backend (keep `sendSessionMessage`).

### S8 — (tester) Coordinator backend + client tests
**Depends on:** S7.

- `test/coordinator-spawn-backend.test.ts`: `sendMessage` calls `sendSessionMessage(agentId,
  msg, false)`; returns `null`; does **not** call the removed relay path.
- `test/coordinator-client.test.ts`: drop the relay `sendMessage` block; keep
  `sendSessionMessage`.
- Update the `SpawnBackend` mock in `test/engine.test.ts` (`sendMessage` now may return `null`).

---

### S9 — (coder) `SessionLifecycle`: thread opts, accept `null`
**Depends on:** S5.

In `drone-gateway/src/surfaces/lifecycle.ts`:

```ts
async send(text: string, opts?: SendMessageOptions): Promise<string | null> {
  return this.run(async () => {
    if (this.disposed) throw new Error('surface disposed');
    const session = await this.ensureSession();
    try {
      const response = await this.opts.ctx.spawnBackend.sendMessage(session, text, opts);
      this.armIdleTimer();
      return response;
    } catch (err) {
      // ... existing one-shot death re-spawn + retry, passing `opts` through ...
    }
  });
}
```
A `null` reply is a **normal** result (not an error): it does not trigger the death-retry path
and it still arms the idle timer.

### S10 — (tester) Lifecycle `null`/opts cases
**Depends on:** S9.

In `test/session-lifecycle.test.ts`: `send` forwards `opts` to `spawnBackend.sendMessage`; a
`null` reply is returned as-is and does **not** trigger a re-spawn; `null` still arms the idle
timer.

---

### S11 — (coder) `MessageBatcher`
**Depends on:** nothing.

New `drone-gateway/src/batcher.ts`:

```ts
import type { AdapterMessage } from './types.js';

/**
 * Buffers inbound messages for one conversation and flushes them as a single
 * batch after a quiet period. The flush callback is expected to serialize on the
 * conversation's dispatch tail, so a flush that arrives during an in-flight turn
 * simply queues behind it.
 */
export class MessageBatcher {
  private buffer: AdapterMessage[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly debounceMs: number,
    private readonly flush: (batch: AdapterMessage[]) => void
  ) {}

  /** Append a message and (re)arm the debounce timer. */
  push(msg: AdapterMessage): void {
    this.buffer.push(msg);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.debounceMs);
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = null;
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.flush(batch);
  }

  /** Cancel any pending flush and drop buffered messages (shutdown). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
  }
}
```

### S12 — (tester) Batcher tests
**Depends on:** S11.

New `test/batcher.test.ts` (Vitest fake timers): a single push flushes once after
`debounceMs`; two pushes inside the window flush **once** with both messages in arrival order;
a push after a flush starts a new batch; `debounceMs: 0` flushes on the next tick; `dispose`
cancels a pending flush and drops the buffer.

---

### S13 — (coder) `DroneControlSurface.handleBatch?`
**Depends on:** nothing.

In `drone-gateway/src/types.ts`:

```ts
export interface DroneControlSurface {
  id: string;
  type: string;
  handleMessage(message: AdapterMessage): Promise<{ response: string | null; handled: boolean }>;
  /**
   * Batch-eligible surfaces implement this. When present on a conversation's
   * sole surface, incoming messages are buffered and delivered here as one
   * ordered batch (see MessageBatcher). Absence = immediate per-message path.
   */
  handleBatch?(messages: AdapterMessage[]): Promise<{ response: string | null; handled: boolean }>;
  dispose?(): Promise<void>;
}
```

### S14 — (coder) `SurfaceContext.debounceMs` + loader sanitization
**Depends on:** nothing.

- `drone-gateway/src/surfaces/types.ts`: add `debounceMs?: number;` (engine-resolved; the
  default is applied by the engine/`MessageBatcher`).
- `drone-gateway/src/config/load.ts`: extend `sanitizeSurfaceConfig` to also sanitize
  `config.batch.debounceMs` via the existing `sanitizeIdleTimeoutMs` rule (rename it to a
  general non-negative-number sanitizer, or add a sibling), and read top-level
  `batch.debounceMs` into `GatewayConfig` exactly as `idleTimeoutMs` is handled. Invalid →
  warn + drop. Add `batch?: { debounceMs?: number }` to `GatewayConfig`.
- Document the caveat: in a multi-surface conversation the surface `batch.debounceMs` is inert.

### S15 — (tester) Config-loader `batch.debounceMs` cases
**Depends on:** S14.

In `test/config-load.test.ts`: a valid surface `config.batch.debounceMs` survives; `0`
survives; a negative / non-number is dropped; top-level `batch.debounceMs` is read; invalid
top-level is omitted.

---

### S16 — (coder) `persona-assignment`: tagging + batching + silence
**Depends on:** S3, S9, S13, S14.

Rewrite `drone-gateway/src/surfaces/persona-assignment.ts` so both entry points share one
send helper:

```ts
import { logger } from '../logger.js';
import type { AdapterMessage } from '../types.js';
import type { SurfaceFactory } from './types.js';
import { SessionLifecycle } from './lifecycle.js';
import {
  formatChatTurn, isNoResponse, ROOM_INSTRUCTION, NO_RESPONSE_SENTINEL,
} from '../chat-format.js';

export const createPersonaAssignmentSurface: SurfaceFactory = (spec, conversationId, ctx) => {
  if (!spec.personaId) throw new Error('persona-assignment control surface requires personaId');
  const personaId = spec.personaId;
  const lifecycle = new SessionLifecycle({ surfaceType: 'persona-assignment', conversationId, personaId, ctx });

  async function sendTurn(messages: AdapterMessage[]) {
    const text = messages.map(formatChatTurn).join('\n');
    const isRoom = messages[0]?.conversationKind === 'room';
    const reply = await lifecycle.send(text, isRoom ? { systemReminder: ROOM_INSTRUCTION } : undefined);
    if (reply === null) {
      logger.info({ conversationId, personaId }, 'No synchronous reply (coordinator mode)');
      return { response: null, handled: true };
    }
    if (isNoResponse(reply)) {
      logger.info({ conversationId, personaId }, 'Agent chose not to respond');
      return { response: null, handled: true };
    }
    return { response: reply.trim() ? reply : null, handled: true };
  }

  return {
    id: `persona-assignment-${conversationId}`,
    type: 'persona-assignment',
    handleMessage: async (msg: AdapterMessage) => {
      try { return await sendTurn([msg]); }
      catch (err) { /* existing Error: … contract */ }
    },
    handleBatch: async (messages: AdapterMessage[]) => {
      try { return await sendTurn(messages); }
      catch (err) { /* existing Error: … contract */ }
    },
    dispose: () => lifecycle.dispose(),
  };
};
```
Keep the `{ response: 'Error: …', handled: true }` catch contract. (`NO_RESPONSE_SENTINEL` is
used only by the tests/docs here; the helper owns the check.)

### S17 — (tester) Surface tests
**Depends on:** S16.

In `test/surfaces/persona-assignment-surface.test.ts`: a DM message is sent as `[Alice] hi`;
a room message is sent with the room `systemReminder`; a batch is joined by newline with each
line tagged; a `<<NO_RESPONSE>>` reply yields `{response: null, handled: true}`; a `null`
reply yields `{response: null, handled: true}` and logs "No synchronous reply"; tagging falls
back to `senderId`/`'unknown'`.

---

### S18 — (coder) Engine: batcher wiring + `debounceMs` + shutdown
**Depends on:** S11, S13, S14, S16.

In `drone-gateway/src/engine.ts`:

1. Extend the record and build the batcher in `start()`:
```ts
type InstantiatedConversation = {
  allowedSenders?: string[];
  surfaces: DroneControlSurface[];
  tail: Promise<unknown>;
  batcher?: MessageBatcher;
};
```
```ts
// in start(), per conversation:
const soleSurface = surfaces.length === 1 ? surfaces[0] : undefined;
const eligible = soleSurface?.handleBatch !== undefined;
byConv.set(convId, {
  allowedSenders: conv.allowedSenders,
  surfaces,
  tail: Promise.resolve(),
  batcher: eligible
    ? new MessageBatcher(
        resolveDebounceMs(conv.surfaces[0]?.config, this.config),
        batch => { void this.dispatchBatch(adapterConfig.id, convId, byConv.get(convId)!, batch); }
      )
    : undefined,
});
```
(`resolveDebounceMs` = surface `config.batch.debounceMs` ?? `config.batch.debounceMs` ?? 500.)

2. In `handleMessage`, route to the batcher before the immediate path:
```ts
const exactApplies = exact !== undefined && senderAllowed(exact.allowedSenders, msg.senderId);
if (exactApplies && exact?.batcher) {
  exact.batcher.push(msg);
  return;
}
// ... existing immediate path unchanged (wildcard included) ...
```

3. Add `dispatchBatch`, which runs the batch through the same serialization + reply logic:
```ts
private async dispatchBatch(adapterId: string, conversationId: string, conv: InstantiatedConversation, batch: AdapterMessage[]): Promise<void> {
  await runOnTail(conv, async () => {
    const surface = conv.surfaces[0];
    if (!surface.handleBatch) return;
    const result = await surface.handleBatch(batch);
    if (result.handled) {
      if (result.response) {
        const adapter = this.adapters.get(adapterId);
        if (adapter) await adapter.sendMessage(conversationId, result.response);
      }
      return;
    }
    logger.debug({ adapterId, conversationId }, 'Batch unhandled by any control surface');
  });
}
```

4. `surfaceContext(spec)` adds `debounceMs` (mirrors `idleTimeoutMs`).

5. In `stop()`, before disposing surfaces, clear every batcher: iterate
`this.controlSurfaces` and call `conv.batcher?.dispose()` (drop pending — we are shutting down).

### S19 — (tester) Engine batching integration tests
**Depends on:** S18.

In `test/engine.test.ts` (reuse the fake-adapter harness): a burst of two messages for a
single-surface exact conversation produces **one** `handleBatch` call containing both in
order; a conversation with a non-`handleBatch` surface uses the immediate path; a multi-surface
conversation uses the immediate path; a room batch forwards `systemReminder` (assert via the
surface mock); `stop()` clears pending batchers. Assert the debounce is honoured with fake
timers.

---

### S20 — (coder) Agent: `systemReminder` on the chat event → system reminder
**Depends on:** nothing (agent-only; local transport from S6).

In `drone-agent/src/runtime/plugin-engine.ts`, add a **public** method beside
`drainSystemReminders`/`clearSystemReminders`:
```ts
queueSystemReminder: (content: string) => systemReminders.queue(content),
```
and add it to the `DronePluginEngine` interface.

In `drone-agent/src/interactive.ts`:
- Extend `InputEvent`: `{ type: 'chat'; message: string; systemReminder?: string }`.
- In `runJsonListenMode`, before `sendUserMessage`, queue it:
```ts
if (typeof event.systemReminder === 'string' && event.systemReminder.trim()) {
  engine.queueSystemReminder(event.systemReminder);
}
```
The conversation service already drains queued reminders into the next LLM call as
non-persisted `<system-reminder>` messages.

### S21 — (tester) Agent reminder tests
**Depends on:** S20.

- `test/plugin-engine.test.ts`: `queueSystemReminder` adds to the queue drained by
  `drainSystemReminders`.
- The JSON-listen suite: a `{type:'chat', message, systemReminder}` line queues the reminder
  before the turn; a line without it queues nothing.
- Assert the reminder is **not** persisted (session history contains only the user message).

---

### S22 — (coder) Docs
**Depends on:** S1–S21.

- New `drone-gateway/docs/adr/006-chat-tagging-batching-optout.md` — the D1–D12 decisions, the
  coordinator send-half fix and the deferred receive half, and the mixed-conversation seed.
- `drone-gateway/CONTEXT.md` — glossary entries: **Chat Tag**, **Message Batcher**,
  **No-Response Sentinel**, **Room Instruction**; amend **Control Surface** (`handleBatch?`),
  **Adapter Message** (`conversationKind`), **Persona Assignment**; config layout
  (`batch.debounceMs`).

### S23 — (reviewer) Full validation
**Depends on:** all.

Run §6 and inspect the diff for dead code (removed relay client method), no unused vars, no
duplicated formatting logic (single `chat-format` helper), and that `swarm-console` still
receives raw text.

## 6. Validation criteria

All must pass. Do not consider the job done until every item is green.

1. **LSP diagnostics clean** on every touched file in `drone-gateway` and `drone-agent`.
2. **Build:** `pnpm -r run build` — zero errors. (Run before trusting LSP/typecheck in
   dependents; they resolve built `dist/`.)
3. **Typecheck:** `pnpm typecheck` — zero errors.
4. **Lint (project "linting" process):** `pnpm run lint` — zero errors. It runs Prettier
   repo-wide; **re-read any file before editing it again**, and revert unrelated Prettier
   churn (`pnpm-lock.yaml`, `.drone-agent/insights/`) before committing.
5. **Fast tests:** `pnpm run test` — all green, including the new `batcher`, `chat-format`,
   and the updated engine/surface/lifecycle/backend/config suites.
6. **Behavioral acceptance (manual; document the result):**
   - A local single-surface `persona-assignment` room: two rapid messages arrive while idle →
     **one** agent turn, both lines tagged, in order, one reply posted.
   - A room message in a DM: tagged (`[Alice] …`) and **no** room instruction is attached.
   - A room message: the room instruction is injected and does **not** appear in session
     history after the turn.
   - An agent reply of exactly `<<NO_RESPONSE>>` → **nothing** is posted; the log shows "Agent
     chose not to respond".
   - `batch.debounceMs: 0` flushes on the next tick; a large value visibly coalesces bursts.
   - **Coordinator mode:** `persona-assignment` send delivers the turn via
     `POST /api/sessions/:id/message` and the gateway posts **nothing** (no junk), logging "No
     synchronous reply".
   - `swarm.help` (a `swarm-console` command) is still parsed raw and answered.
7. **Dead-code / fluff sweep:** the relay `CoordinatorClient.sendMessage` is gone with no
   dangling callers; no unused imports/vars/comments introduced; the tagging/merge logic lives
   only in `chat-format.ts` + the surface.

## 7. Out of scope (explicitly deferred)

- Coordinator-mode **receive path** (gateway WS subscription to `/ws`); separate plan.
- `systemReminder` over the **coordinator** transport (rides with the above).
- **Mixed-surface conversation batching** (seed: `planning-seed-mixed-conversation-batching`).
- **Per-sender session isolation.**
- A silence **tool** (`chat__stay_silent`).

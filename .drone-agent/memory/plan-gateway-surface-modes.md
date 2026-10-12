---
key: plan-gateway-surface-modes
tags:
  - plan
  - drone-gateway
  - control-surface
  - surface-modes
  - persona-assignment
  - observer
  - passive
  - mentions
  - catch-up-loop
created: 2026-10-12T02:15:38.461Z
updated: 2026-10-12T02:15:38.461Z
---

---
name: plan-gateway-surface-modes
description: Plan B — drone-gateway per-surface `mode` (active | passive | observer) with a catch-up loop and @-mention reply lift
tags: [plan, drone-gateway, control-surface, surface-modes, persona-assignment, observer, passive, mentions, catch-up-loop]
created: 2026-10-11
updated: 2026-10-11
---

# Plan B — Gateway surface modes (`active` | `passive` | `observer`)

## What this is and why

`persona-assignment` is the gateway's only spawning control surface. Today it behaves
one way: every inbound message becomes a turn, and the reply is posted. That shape is
wrong for two wanted deployment shapes:

- **A notetaker / observer** — a persona that watches a room, builds memory / wiki /
  todos, but must **never** post in chat.
- **A passive assistant** — an observer that wakes and *answers* the instant it is
  `@`-mentioned, and is otherwise silent.

This plan adds a per-surface **`config.mode`** with three values:

| Mode | Turns | Replies |
|---|---|---|
| `active` (default) | one turn per message (today's behaviour) | posts the reply |
| `passive` | buffers messages; a turn runs on the catch-up timer **or** immediately on `@`-mention | posts **only** on a mention round |
| `observer` | buffers messages; a turn runs on the catch-up timer | **never** posts |

Mode is a **delivery-and-reply axis**, not a reply filter: `passive`/`observer` do not
run a turn per message at all (an observer that ran a turn per message and discarded the
reply would be a token furnace). "Catch-up" is exactly *flush the surface-side inbound
buffer as one turn*.

This is **Plan B** of the drone-gateway portable-context work. **Plan A** (ADR 249,
merged) shipped first and is a hard dependency: the snapshot/restore + outbound-ledger
continuity it added is what makes a long-lived, slow-cadence, sometimes-silent agent
coherent. Plan B starts from the Plan A base (branch tip `15258dc2`, ADR 249).

## Locked decisions (from the grilling)

| # | Decision |
|---|---|
| 1 | Mode is a **delivery-and-reply** axis. `active`: turn + reply per message. `passive`: buffer (no turn); flush on mention **or** timer; reply only on a mention round. `observer`: buffer; flush on timer only; never reply. |
| 2 | A **catch-up = flush the surface-side inbound buffer as one turn**. The buffer is **in-memory** on the surface. It survives an idle-timeout terminate (it is not part of `SessionLifecycle`); it does **not** survive a gateway restart (accepted). No adapter history read exists or is added — the live buffer *is* the history. |
| 3 | The observer/passive periodic flush is a **surface-local `setInterval`**, `unref()`'d, armed continuously from surface construction. An **empty buffer is a no-op** (no spawn, no turn). Cadence = `config.catchUp.intervalMs`, default **900000** (15 min); `0` disables the timer. There is **no** scheduled *outbound* work (use the injection API). |
| 4 | **`@`-mention detection lives in the adapter** — only it knows the bot's own identity (`config.userId`) and sees raw event content. New optional `AdapterMessage.mentionsBot?: boolean`, stamped from `content['m.mentions'].user_ids.includes(config.userId)`. **`m.mentions` only** in v1. A plain-text fallback (`@<localpart>` / display name) is a **maybe-later** (fragile; a missed mention degrades to the normal cadence, not to silence). |
| 5 | The mention lift is **kind-agnostic** — no `conversationKind === 'room'` guard (that guard is *more* code). Consequence: a `passive` **DM** bot replies only if explicitly `@`-mentioned (rare; harmless). Document it. |
| 7 | `handleBatch` stays **defined in all modes**. `handleMessage` and `handleBatch` both funnel into one shared `ingest(messages)`. The engine's `MessageBatcher` eligibility rules are **unchanged** (its burst-coalescing lifetime is orthogonal to the catch-up buffer). A mention is detected with `messages.some(m => m.mentionsBot)`. A flush drains the buffer **atomically** (snapshot-and-clear) on the `SessionLifecycle` tail; arrivals during a flush land in the next window. |
| 8 | Reply control is **two layers**: (a) a per-turn instruction from `chat-format.ts`; (b) a **hard, code-enforced** surface block — `observer` and ordinary `passive` catch-ups always return `{response:null, handled:true}` (the turn's tool/memory side effects still happen). Discarding modes **log** `Error:`-shaped replies at `warn` and post nothing. Fold in: filter the `CANCEL_SENTINEL` (`'__CANCELLED__'`) at the reply-decision site. |
| 10 | `config.mode` ∈ `"active" \| "passive" \| "observer"` (absent ⇒ `active`); `config.catchUp.intervalMs` (non-negative number; absent ⇒ 900000; `0` disables; inert in `active`). An **invalid `mode` value throws** (hard load error, mirroring `targetBeaconId` — a typo must not silently make a notetaker chatty). An invalid `catchUp.intervalMs` is **warned and dropped**. No spawning-surface guard. Defaults applied **surface-side** (via the engine-resolved `SurfaceContext`). Keep the `SurfaceMode` primitive clean — it will be reused for swarm-managed agents. |
| 11 | Plan A's continuations (ledger drain, snapshot/restore, idle timer) are **mode-agnostic** and run in every mode. Note the cadence arithmetic: with defaults, `idleTimeoutMs` (5 min) < `catchUp.intervalMs` (15 min), so **every** observer tick is a cold-spawn + restore — correct *because* Plan A exists. **Document** the coupling; do **not** auto-couple the two knobs. |
| 12 | A mention-bearing ingest always **requests a flush**; flushes serialize on the lifecycle tail, so a mention arriving during a flush produces an immediate follow-up turn (not a wait for the timer). The periodic timer is **independent** — it fires on its own cadence and is **not** re-armed on activity. A manual "flush now" trigger is **deferred**. |

**Explicitly out of scope:** emoji reactions; a `mention-router` (`!persona`) surface;
scheduled *outbound* work; a persisted catch-up buffer; the plain-text mention fallback; a
manual flush trigger; coordinator-mode support (there is no coordinator receive path — its
`sendMessage` returns `null`).

## Files to change

- `drone-gateway/src/surfaces/mode.ts` — **new** leaf module (types + helpers).
- `drone-gateway/src/chat-format.ts` — two new instruction constants, a composer, a sentinel filter.
- `drone-gateway/src/types.ts` — `AdapterMessage.mentionsBot?`.
- `drone-gateway/src/config/load.ts` — validate `mode` / `catchUp` in `sanitizeSurfaceConfig`.
- `drone-gateway/src/surfaces/types.ts` — `SurfaceContext` gains `mode` + `catchUpIntervalMs`.
- `drone-gateway/src/engine.ts` — resolve `mode`/`catchUpIntervalMs` into `SurfaceContext`; log them.
- `drone-gateway/src/adapters/matrix.ts` — stamp `mentionsBot`.
- `drone-gateway/src/surfaces/persona-assignment.ts` — the mode machine (buffer, timer, ingest, flush, reply blocking).
- `drone-gateway/CONTEXT.md` — glossary entries.
- `docs/adr/250-gateway-surface-modes.md` — **new** ADR (canonical home; see AGENTS.md).
- Tests: `test/surface-modes.test.ts` (new), `test/surface-modes-acceptance.test.ts` (new), plus edits to `test/config-load.test.ts`, `test/chat-format.test.ts`, `test/engine.test.ts`, `test/matrix-adapter.test.ts`, `test/persona-assignment-surface.test.ts`.

---

## Phase 0 — `surfaces/mode.ts` (leaf module)

Create `drone-gateway/src/surfaces/mode.ts`. It must import nothing (a leaf, like
`surfaces/requirements.ts`) so the loader, engine, and surfaces can all use it without a
cycle.

```ts
export type SurfaceMode = 'active' | 'passive' | 'observer';

export const SURFACE_MODES: readonly SurfaceMode[] = [
  'active',
  'passive',
  'observer',
];

export const DEFAULT_SURFACE_MODE: SurfaceMode = 'active';

/** Observer/passive periodic catch-up cadence (ms) when nothing else is set. */
export const DEFAULT_CATCH_UP_INTERVAL_MS = 900_000;

export function isSurfaceMode(value: unknown): value is SurfaceMode {
  return (
    typeof value === 'string' &&
    (SURFACE_MODES as readonly string[]).includes(value)
  );
}
```

Tests (`test/surface-modes.test.ts`): `isSurfaceMode` accepts each member, rejects
`'Active'`, `''`, `undefined`, `42`; `SURFACE_MODES` has exactly three members;
`DEFAULT_SURFACE_MODE === 'active'`; `DEFAULT_CATCH_UP_INTERVAL_MS === 900_000`.

---

## Phase 1 — `chat-format.ts`: instructions, composer, sentinel filter

Add to `drone-gateway/src/chat-format.ts` (import the *type* only:
`import type { SurfaceMode } from './surfaces/mode.js';`):

```ts
/** The per-turn instruction for a silent observation round (observer, and a
 *  passive conversation's ordinary catch-up). */
export const OBSERVER_INSTRUCTION =
  'You are observing this conversation as a silent notetaker. Other people are talking to\n' +
  'each other. Do NOT reply in chat. Use your tools to record anything worth remembering\n' +
  '(notes, memories, wiki pages, todos); anything you would say is for your own records only.';

/** The per-turn instruction for a passive conversation's mention round. */
export const MENTION_INSTRUCTION =
  'You have been mentioned in this conversation. In addition to your usual observation,\n' +
  'you MUST reply to the last message, addressing the person who mentioned you.';

/** `'__CANCELLED__'` — the soft-cancel sentinel produced by a cancelled agent turn. */
export const CANCEL_SENTINEL = '__CANCELLED__';

/** True when a reply is the soft-cancel sentinel (never post it). */
export function isCancelled(reply: string): boolean {
  return reply.trim() === CANCEL_SENTINEL;
}

/**
 * The non-persisted system reminder for a turn, selected by mode. `undefined`
 * means "no reminder" (a plain active DM turn). In a room an active turn keeps
 * ROOM_INSTRUCTION; an observer/passive round uses the observation instruction
 * instead (so the model is told not to reply rather than told it may decline).
 */
export function composeSystemReminder(
  mode: SurfaceMode,
  kind: 'dm' | 'room',
  mentioned: boolean
): string | undefined {
  if (mode === 'active') return kind === 'room' ? ROOM_INSTRUCTION : undefined;
  if (mode === 'observer') return OBSERVER_INSTRUCTION;
  return mentioned ? MENTION_INSTRUCTION : OBSERVER_INSTRUCTION;
}
```

Tests (`test/chat-format.test.ts`, extend): `composeSystemReminder('active','room',…)`
=== `ROOM_INSTRUCTION`; `('active','dm',…)` === `undefined`; `('observer',*)` ===
`OBSERVER_INSTRUCTION`; `('passive',*,true)` === `MENTION_INSTRUCTION`;
`('passive',*,false)` === `OBSERVER_INSTRUCTION`; `isCancelled` true for
`'__CANCELLED__'` and `'  __CANCELLED__  '`, false for `''` and normal text.

---

## Phase 2 — plumbing: types, loader, `SurfaceContext`, engine

### 2a. `AdapterMessage.mentionsBot?` — `src/types.ts`

Add to the `AdapterMessage` interface, after `platformRef?`:

```ts
  /**
   * True when this inbound message `@`-mentions the gateway bot's own identity
   * (Matrix `m.mentions`). Adapter-stamped; surfaces treat it as opaque truth.
   */
  mentionsBot?: boolean;
```

### 2b. Loader — `src/config/load.ts`, inside `sanitizeSurfaceConfig`

The function already builds `rest` from `config`. Add a `mode` branch (throw, like
`targetBeaconId`) and a `catchUp` object bag (warn-and-drop, like `lifecycle`/`batch`).
Import `isSurfaceMode` and `SURFACE_MODES` from `../surfaces/mode.js`.

```ts
  const mode = rest.mode;
  if (mode !== undefined && !isSurfaceMode(mode)) {
    throw new Error(
      `Control surface type "${type}" in "${file}" (conversation "${convId}", ` +
        `adapter "${adapterId}") has an invalid mode "${String(mode)}" ` +
        `(expected one of: ${SURFACE_MODES.join(', ')}).`
    );
  }

  const catchUp = rest.catchUp;
  if (catchUp !== undefined) {
    if (typeof catchUp !== 'object' || catchUp === null || Array.isArray(catchUp)) {
      warn('catchUp is not an object; ignoring');
      delete rest.catchUp;
    } else {
      const bag = { ...(catchUp as Record<string, unknown>) };
      if (bag.intervalMs !== undefined) {
        const sanitized = sanitizeNonNegativeNumber(
          bag.intervalMs,
          'intervalMs',
          warn
        );
        if (sanitized === undefined) delete bag.intervalMs;
        else bag.intervalMs = sanitized;
      }
      rest.catchUp = bag;
    }
  }
```

Add the doc comment on `sanitizeSurfaceConfig` to mention `mode` / `catchUp.intervalMs`.

### 2c. `SurfaceContext` — `src/surfaces/types.ts`

Add (import the type from `./mode.js`):

```ts
  /** Mode for spawning surfaces. `active` is the default and the current behaviour. */
  mode: SurfaceMode;
  /**
   * Periodic catch-up cadence (ms) for `observer`/`passive`. `0` disables the
   * timer. Inert in `active`. Engine-resolved; defaults applied before injection.
   */
  catchUpIntervalMs: number;
```

### 2d. Engine — `src/engine.ts`

In `surfaceContext(spec, adapterId)`, resolve and inject:

```ts
    const catchUp = cfg.catchUp as { intervalMs?: number } | undefined;
    const mode = isSurfaceMode(cfg.mode) ? cfg.mode : DEFAULT_SURFACE_MODE;
    const catchUpIntervalMs =
      catchUp?.intervalMs ?? DEFAULT_CATCH_UP_INTERVAL_MS;
    return {
      // …existing fields…
      mode,
      catchUpIntervalMs,
    };
```

In `describeSurface`, append the mode for spawning surfaces, e.g.
`` `${spec.type}(${mode === 'coordinator' ? `coordinator:${beacon}` : 'local'},${surfaceMode})` ``.
Resolve `surfaceMode` the same way (`isSurfaceMode(cfg.mode) ? cfg.mode : DEFAULT_SURFACE_MODE`)
and log the catch-up interval for non-active surfaces. Import the helpers from
`./surfaces/mode.js`.

**Sweep:** adding **required** `mode`/`catchUpIntervalMs` to `SurfaceContext` breaks every
literal that constructs one — the engine, all surface factories' tests, and
`test/persona-assignment-surface.test.ts`'s `makeSurface`. Use LSP find-references on
`SurfaceContext` to enumerate; then `pnpm -r run build` and fix the fallout. (Consider
defaulting them **optional** in the type if the sweep proves noisy — but required is
cleaner and matches `spawnBackend`.)

Tests (`test/config-load.test.ts`): valid `mode` accepted; invalid `mode` **throws**;
absent → absent from config (defaults are surface-side); valid/invalid
`catchUp.intervalMs`; `catchUp` non-object warned+dropped. (`test/engine.test.ts`): the
resolved `ctx.mode`/`ctx.catchUpIntervalMs` for an explicit mode, and the defaults for an
absent one.

---

## Phase 3 — Matrix adapter stamps `mentionsBot`

In `src/adapters/matrix.ts`, `onTimelineEvent`, after `const content = event.getContent();`
and the body extraction:

```ts
    const mentionIds = (
      content?.['m.mentions'] as { user_ids?: string[] } | undefined
    )?.user_ids;
    const mentionsBot = Array.isArray(mentionIds)
      ? mentionIds.includes(this.config.userId)
      : false;
```

and add `mentionsBot` to the emitted `AdapterMessage`.

Tests (`test/matrix-adapter.test.ts`, extend): an `m.room.message` whose content carries
`m.mentions.user_ids` including `config.userId` ⇒ `mentionsBot === true`; a mention of
someone else or no `m.mentions` ⇒ falsy/absent; malformed `m.mentions` does not throw.

---

## Phase 4 — `persona-assignment`: the mode machine

Rewrite `src/surfaces/persona-assignment.ts`. Keep the existing `spec.personaId`
requirement, the `SessionLifecycle`, and the outbound-ledger drain (Plan A). Add the
buffer, the timer, the `ingest` funnel, and the hard reply block.

Sketch (adapt names to the file's style):

```ts
export const createPersonaAssignmentSurface: SurfaceFactory = (
  spec,
  conversationId,
  ctx
) => {
  if (!spec.personaId) {
    throw new Error('persona-assignment control surface requires personaId');
  }
  const personaId = spec.personaId;
  const { mode, catchUpIntervalMs } = ctx;
  const lifecycle = new SessionLifecycle({
    surfaceType: 'persona-assignment',
    conversationId,
    personaId,
    ctx,
  });
  const ledger = ctx.outboundLedger;

  /** Inbound messages accumulated since the last flush (observer/passive). */
  let buffer: AdapterMessage[] = [];
  let timer: NodeJS.Timeout | null = null;

  function buildPreamble(): { text: string; ids: number[] } {
    /* unchanged from Plan A */
  }

  /** Snapshot-and-clear: callers get a private array; new arrivals start fresh. */
  function takeBuffer(): AdapterMessage[] {
    const drained = buffer;
    buffer = [];
    return drained;
  }

  async function runTurn(
    messages: AdapterMessage[],
    mentioned: boolean
  ): Promise<{ response: string | null; handled: boolean }> {
    const { text: preamble, ids } = buildPreamble();
    const text = preamble + messages.map(formatChatTurn).join('\n');
    const kind = messages[0]?.conversationKind ?? 'dm';
    const reminder = composeSystemReminder(mode, kind, mentioned);
    const reply = await lifecycle.send(
      text,
      reminder ? { systemReminder: reminder } : undefined
    );
    if (ledger && ids.length > 0) ledger.remove(ids);

    if (reply === null) return { response: null, handled: true };
    if (isCancelled(reply)) {
      logger.info({ conversationId, personaId }, 'Agent turn cancelled; posting nothing');
      return { response: null, handled: true };
    }
    if (isNoResponse(reply)) {
      logger.info({ conversationId, personaId }, 'Agent chose not to respond');
      return { response: null, handled: true };
    }
    if (reply.startsWith('Error:')) {
      logger.warn({ conversationId, personaId }, `Agent turn failed: ${reply}`);
      return { response: mode === 'active' ? reply : null, handled: true };
    }

    // Hard reply block for the discarding modes.
    if (mode !== 'active' && !(mode === 'passive' && mentioned)) {
      return { response: null, handled: true };
    }
    return { response: reply.trim() ? reply : null, handled: true };
  }

  /** Flush the buffered window as one turn (observer cadence, passive cadence, mention). */
  async function flush(mentioned: boolean): Promise<{ response: string | null; handled: boolean }> {
    const drained = takeBuffer();
    if (drained.length === 0) return { response: null, handled: true };
    try {
      return await runTurn(drained, mentioned);
    } catch (err) {
      logger.error({ err, conversationId, personaId }, 'Catch-up turn failed');
      return { response: null, handled: true };
    }
  }

  /** Buffer messages; flush now on a passive mention, else let the timer flush. */
  async function ingest(messages: AdapterMessage[]) {
    if (mode === 'active') return runTurn(messages, false);
    buffer.push(...messages);
    const mentioned = messages.some(m => m.mentionsBot);
    if (mode === 'passive' && mentioned) return flush(true);
    return { response: null, handled: true };
  }

  if (mode !== 'active' && catchUpIntervalMs > 0) {
    timer = setInterval(() => {
      void lifecycle.run(() => flush(false));
    }, catchUpIntervalMs);
    timer.unref();
  }

  return {
    id: `persona-assignment-${conversationId}`,
    type: 'persona-assignment',
    handleMessage: (msg: AdapterMessage) => ingest([msg]),
    handleBatch: (messages: AdapterMessage[]) => ingest(messages),
    dispose: async () => {
      if (timer) { clearInterval(timer); timer = null; }
      await lifecycle.dispose();
    },
  };
};
```

Implementation notes to preserve:

- **`lifecycle.send` already serializes on the lifecycle tail** and owns spawn / idle /
  death-retry / snapshot. The buffer+flush does not add a second tail; `flush` from the
  timer is wrapped in `lifecycle.run(...)` so it can never overlap an in-flight turn.
  `ingest`'s active path and its passive-mention `flush(true)` both go through `send`'s
  own `run`, so ordering is already correct. *Do not* double-wrap.
- **A mention flush must run immediately, not on the timer**, and its reply must be
  returned to the engine (so the engine posts it). That is why `flush(true)` is awaited
  inside `ingest` (which is inside the engine's dispatch), whereas the timer calls
  `flush(false)` detached and ignores the result (observer/passive-ordinary never reply).
- **Empty buffer ⇒ no-op** — `flush` returns early without spawning.
- **`error` handling**: a thrown turn in a discarding mode returns
  `{response:null,handled:true}` and logs; it never posts.
- **`mode==='active'` is behaviour-preserving** — same text, same reminder rule (room ⇒
  `ROOM_INSTRUCTION`), same reply handling, plus the new `isCancelled` filter.

Tests (`test/persona-assignment-surface.test.ts`, extend extensively; use the existing
`vi.useFakeTimers()` harness):
- `active`: unchanged assertions still pass (tag + room reminder + reply + ledger).
- `observer`: N messages ⇒ `sendMessage` not called; advance the timer ⇒ exactly one
  `sendMessage`, text joins all N tagged lines, `systemReminder` is `OBSERVER_INSTRUCTION`,
  result is `{response:null,handled:true}` even though the backend returned text.
- `observer` with `catchUpIntervalMs = 0`: timer never fires; buffer never flushes.
- empty-buffer tick ⇒ no spawn, no send.
- `passive`: buffer, no send; a `mentionsBot` message ⇒ one `sendMessage` whose reminder is
  `MENTION_INSTRUCTION` and whose reply is returned (posted).
- `passive` ordinary timer flush ⇒ no reply.
- mid-flush arrival: enqueue during an in-flight flush ⇒ next window (buffer non-empty
  again, exactly one more turn after the next trigger).
- `CANCEL_SENTINEL` reply ⇒ `{response:null,handled:true}` and a log, in every mode.
- `Error:` reply ⇒ `active` returns it, observer/passive-ordinary return `null` and warn.
- `mentionsBot` ignored in `active` (behaviour unchanged).
- `dispose()` clears the timer (no further flush after dispose).

---

## Phase 5 — ADR 250 + `CONTEXT.md`

Write `docs/adr/250-gateway-surface-modes.md` (canonical; the wiki page under
`decisions/` is a pointer stub — see `meta/decision-bug-fixes-go-in-decisions` and
AGENTS.md). It must record: the mode axis; the in-memory buffer; "catch-up = flush the
live buffer"; the adapter-side `m.mentions` detection (+ the deferred text fallback); the
kind-agnostic lift; the atomic drain + independent timer; the two-layer reply control
(the folded-in `CANCEL_SENTINEL` filter); the **throw-on-invalid-`mode`** validation; the
Plan A coupling note (idle < catch-up ⇒ cold-spawn-per-tick, by design); and the
out-of-scope list.

`drone-gateway/CONTEXT.md` glossary additions/edits: **Surface Mode**, **Catch-Up
(Flush)**, **Catch-Up Cadence** (`catchUp.intervalMs`), **Observation Instruction**,
**Mention Lift** (note the kind-agnostic/DM consequence), **Mention Detection**
(`AdapterMessage.mentionsBot`, `m.mentions`); amend **Persona Assignment** and the config
layout block with `mode` / `catchUp`.

---

## Phase 6 — acceptance test + standards

`test/surface-modes-acceptance.test.ts`: drive the **engine** (not the surface) with a fake
adapter + the existing fake-backend harness + fake timers. Three scenarios in one file:

1. **observer**: three inbound messages ⇒ no `sendMessage`; advance the catch-up timer ⇒
   one turn carrying all three tagged lines, `OBSERVER_INSTRUCTION`, and **no** post.
2. **passive**: two messages buffered, then a mention ⇒ exactly one turn carrying the
   backlog + the mention, `MENTION_INSTRUCTION`, and **one** post.
3. **active** (regression): one message ⇒ one turn + one post with today's semantics.

Then the standards pass (see validation criteria).

---

## Validation criteria

- **LSP clean** on every changed file **and** the workspace — zero errors, zero warnings
  (the TypeScript LSP is connected; the repo has no other required server for these files).
- **`pnpm -r run build`** passes (drone-core first — Plan A types are consumed here).
- **`pnpm typecheck`** passes.
- **`pnpm run lint`** passes (this runs Prettier; **re-read changed files before any
  further edit** afterwards).
- **`pnpm run test`** (the fast suite) passes, including all new/updated gateway tests.
- **LSP find-references sweep:** every `SurfaceContext` literal and every
  `AdapterMessage` literal in the repo compiles after the new members (the compiler is the
  ground truth; grep as a cross-check).
- **Every new branch is unit-covered** — the per-mode reply matrix, the mention trigger,
  the empty-buffer no-op, the timer-disable (`0`), the `CANCEL_SENTINEL` filter, the
  discarding-mode error path, and the throw/warn validation branches.
- **No dead code, no fluff comments** (repo standard); comments only where they explain a
  non-obvious decision (the atomic drain, the detached timer flush).
- **The acceptance test passes.**
- **ADR 250** written at `docs/adr/250-gateway-surface-modes.md`; `CONTEXT.md` glossary
  updated.
- **Behaviour preservation:** `mode: active` (including absent) is byte-for-byte the
  current behaviour except the folded-in `CANCEL_SENTINEL` filter, which the tests pin.
- **`.drone-agent` memory files** (this plan, plus any insights) are committed with the
  change set on the feature branch — never to `main`.

## Deferred (recorded, not built)

- Emoji reactions (the `platformRef` seam already exists; see the reactions sketch).
- A `mention-router` (`!persona`) control surface.
- Scheduled *outbound* work (the injection API covers it).
- A persisted catch-up buffer (survives a gateway restart).
- The plain-text `@`-mention fallback.
- A manual "flush now" trigger.
- Coordinator-mode support (blocked on the coordinator receive path).

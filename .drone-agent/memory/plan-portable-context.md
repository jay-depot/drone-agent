---
key: plan-portable-context
tags: []
created: 2026-10-11T20:16:50.825Z
status: completed
updated: 2026-10-11T22:11:14.122Z
---

# Plan: Portable Context + `checkpoint` Plugin

Status: READY FOR EXECUTION. All design decisions finalized in a grilling session (2026-10-11). Every choice is spelled out below; do not re-litigate.

## 0. ADDENDUM — NDJSON stdin/wire protocol support (decision D16)

Portable context must be drivable over the `--output-json` stdin NDJSON protocol (`runJsonListenMode`, `drone-agent/src/interactive.ts` ~L232), so the gateway (next iteration) can export/import a context over the child-process wire without a plugin.

**New input events** (extend the `InputEvent` union in `interactive.ts`):

```ts
| { type: 'exportContext' }
| { type: 'importContext'; context: DronePortableContextExport }
```

**New output events** (extend the `OutputEvent` union in `output-handlers.ts`):

```ts
| { type: 'contextExport'; ok: true; context: DronePortableContextExport }
| { type: 'contextExport'; ok: false; error: string }
| { type: 'contextImport'; ok: true; warnings: string[]; unavailableTools: string[] }
| { type: 'contextImport'; ok: false; error: string }
```

- These are **control commands on the same stdin stream** — NOT turns. They must NOT call `onBeforePrompt`/`onAfterToolCall` and must NOT emit `turnComplete`. They are handled BEFORE the `event.type !== 'chat'` rejection branch.
- `exportContext` → call the engine-seeded `portable-context` capability's `exportContext()`; emit `contextExport`. No plugin required (capability is engine-seeded).
- `importContext` → `portable-context` capability's `importContext(event.context)`; emit `contextImport` with `ok/warnings/unavailableTools`. Import DOES run the full orchestration (recycle → restore → remount → disclosure) — it mutates the session exactly like `/checkpoint restore`. Failures (bad `context`, version mismatch, missing capability) → `{ type: 'contextImport', ok: false, error }`, never a crash.
- **Scope:** `runJsonListenMode` only. `runSwarmListenMode` reads no stdin; the gateway uses `runJsonListenMode`. Do not touch the swarm WS path.
- Add to the Phase 2 code == `interactive.ts`; add tests to Phase 7 (feed `{type:'exportContext'}` / `{type:'importContext', context}` lines, assert output kinds + that no `turnComplete` fires + that import mutates the session). Add to validation §6 and docs Phase 8.

---

## 1. Summary — what and why

Build **portable context**: a standardized, versioned JSON serialization of a session's _context_ (not its identity), plus a _continuation_ path that restores it as a brand-new session. The first consumer is an opt-in `checkpoint` plugin that saves/restores named context snapshots under `./.drone-agent/checkpoints`.

A portable context contains:

- **All session turns**, faithful, with compaction summaries preserved inline (`kind: 'summary'`). Every _other_ system message (system prompt, runtime-flags, footer fragments) is omitted — those are regenerated per request and never live in the session manager. Summaries are the only `role:'system'` messages that survive.
- **The full tool catalog** (all registered tools) plus each tool's `mounted` state.
- **An open `pluginData` map** keyed by plugin id — arbitrary JSON contributed by plugins via an export callback.

Continuation restores turns, **recycles the session** (fresh session id — swarm gets a new transcript), then **remounts** as many saved tools as still exist and **clearly tells the LLM which are gone**.

**No core consumer.** The capability is inert until a plugin calls it (the NDJSON stdin commands in §0 and the `checkpoint` plugin are the first consumers). This feature intentionally ships as dead code by default.

## 2. Non-goals (must not be blocked by this work)

- `swarm-checkpoint` plugin (swarm-stored checkpoints) — future.
- herdr / gateway consumers of portable context — future (the gateway will use the §0 NDJSON commands).
- Any change to existing `/swarm-session import <id>` behavior. It must keep working exactly as-is. (Imported swarm summaries already live in the session as ordinary turns, so they ride into a portable export for free — no hook needed.)

## 3. Architecture overview

- **Engine-seeded capability** `portable-context` (`DRONE_PORTABLE_CONTEXT_CAPABILITY_ID = 'portable-context'`), created and `capabilities.set` **before** plugin registration — mirroring the `reference` capability. Contributors reach it by declaring `{ id: DRONE_PORTABLE_CONTEXT_CAPABILITY_ID, optional: true }` in their plugin metadata and calling `registration.request<DronePortableContextCapability>(DRONE_PORTABLE_CONTEXT_CAPABILITY_ID)`.
- **Session recycle = the clear boundary.** `clearSession` is the session boundary _and_ the session-id generator. Fixed engine-owned order (no plugin depends on hook registration order):
  1. `runHooks('onSessionClear', { sessionId: oldId })` — outgoing session **intact** (turns present, old id).
  2. `conversation.clearSession()` — drain queues/steers/reminders, reset guardrail counters, empty turns.
  3. Engine **mints a fresh `currentSessionId`**.
  4. `runHooks('onSessionRecycle', { sessionId: newId, previousSessionId: oldId })` — new session empty; swarm re-registers under the new id.
  - **Empty gate:** steps 1/3/4 run only when the outgoing session has ≥1 turn. If empty, run only the mechanical clear (step 2). This subsumes "skip recycle when the import target is empty".
- **Engine owns `currentSessionId`** (host-seeded: `--session-id` → `DRONE_SESSION_ID` → `agent-<Date.now()>` fallback, moved out of the swarm plugin). Exposed via `_runtime.getSessionId()`. The swarm plugin _reads_ it instead of minting privately; recycle mints a fresh one.

## 4. Schema (v1)

`drone-core/src/portable-context-types.ts` (new):

```ts
import type {
  DroneSessionMessage,
  DroneSessionTurn,
  DroneToolJsonSchema,
} from './index.js'; // adjust to existing modules

export const DRONE_PORTABLE_CONTEXT_CAPABILITY_ID = 'portable-context';
export const MIN_CONTEXT_SCHEMA_VERSION = 1;
export const MAX_CONTEXT_SCHEMA_VERSION = 1;
export const CURRENT_CONTEXT_SCHEMA_VERSION = 1;

export type DronePortableContextTool = {
  name: string;
  description: string;
  inputSchema?: DroneToolJsonSchema;
  defaultHidden?: boolean;
  mounted: boolean;
};

export type DronePortableContextSessionTurn = {
  kind?: 'summary';
  messages: DroneSessionMessage[]; // turn id intentionally omitted
};

export type DronePortableContextSession = {
  sourceSessionId?: string;
  turns: DronePortableContextSessionTurn[];
};

export type DronePortableContextExport = {
  version: number;
  createdAt: string; // ISO
  session: DronePortableContextSession;
  tools: DronePortableContextTool[];
  pluginData: Record<string, unknown>;
};

export type DronePortableContextExportContext = {
  turns: readonly DroneSessionTurn[];
};
export type DronePortableContextImportContext = {
  turns: readonly DroneSessionTurn[];
};

export type DronePortableContextContributor = {
  id: string; // the pluginData key (plugin id)
  export: (
    ctx: DronePortableContextExportContext
  ) => unknown | Promise<unknown>;
  import?: (
    data: unknown,
    ctx: DronePortableContextImportContext
  ) => void | Promise<void>;
};

export type DronePortableContextImportResult = {
  warnings: string[];
  unavailableTools: string[];
};

export type DronePortableContextCapability = {
  registerContributor: (c: DronePortableContextContributor) => void;
  unregisterContributor: (id: string) => void;
  getContributors: () => DronePortableContextContributor[];
  exportContext: () => Promise<DronePortableContextExport>;
  importContext: (
    data: DronePortableContextExport
  ) => Promise<DronePortableContextImportResult>;
};
```

**Serialization rules**

- Turn `id`s are dropped on export (messages have no id). On import, turns are re-created with fresh `randomUUID()` ids.
- Summaries stay inline in `turns`; export in order (head summary block preserved by natural ordering).
- **Images are exported verbatim** (full `DroneImageContent` incl. base64 `data` + `description`).
- Version is accepted iff `MIN_CONTEXT_SCHEMA_VERSION ≤ version ≤ MAX_CONTEXT_SCHEMA_VERSION`; otherwise reject with a clear error and **do not mutate the session**. Unknown `pluginData` keys → ignore + push a warning into `warnings[]`. Missing `pluginData` keys → skip that contributor's `import`.
- Import contributor failures are **soft** (per-contributor try/catch → warning). Marked "for now"; revisit after real-world use.

Export from drone-core: add `export * from './portable-context-types.js';` to `drone-core/src/index.ts`.

## 5. Phases

### Phase 0 — ADRs (docs)

- `docs/adr/246-portable-context.md`: capability home + engine-seeding rationale, schema v1, versioning constants, contributor API, the clear-boundary recycle contract, empty-gate, images-verbatim, no-core-consumer, the NDJSON stdin/wire commands (§0).
- `docs/adr/247-checkpoint-plugin.md`: checkpoint command surface, storage layout, auto-checkpoint templates, `--checkpoint.restore` dotted flag, soft import failures.
- Agent: `code` (or `plan`). No code deps.

### Phase 1 — drone-core types (foundation)

Files:

- NEW `drone-core/src/portable-context-types.ts` (schemas above).
- `drone-core/src/index.ts` — export the new module.
- `drone-core/src/plugin-system.ts`
  - Add to `DronePluginHooks`:
    ```ts
    onSessionClear: (callback: (payload?: DroneSessionClearPayload) => Promise<void>) => void;
    onSessionRecycle: (callback: (payload: DroneSessionRecyclePayload) => Promise<void>) => void;
    ```
  - New payload types:
    ```ts
    export type DroneSessionClearPayload = { sessionId: string };
    export type DroneSessionRecyclePayload = {
      sessionId: string;
      previousSessionId: string;
    };
    ```
    (Keep `onSessionClear`'s payload optional so existing zero-arg callbacks/subscribers stay valid.)
  - `onSessionRecycle` is a **standard hook** (leave it in `DroneStandardHookName`; do NOT add to the Exclude list).
- `drone-core/src/capabilities.ts` — add:
  ```ts
  export type DroneCheckpointCapability = {
    runStartupRestore: () => Promise<{ ok: boolean; summary: string }>;
  };
  ```
- `drone-core/src/config-types.ts`
  - `export type DroneCheckpointConfig = { autoOnSessionEnd: boolean; autoOnRoundComplete: boolean };`
  - Add `checkpoint: DroneCheckpointConfig;` to `DroneAgentConfig` and `checkpoint: Partial<DroneCheckpointConfig>;` to `PartialDroneAgentConfig`.
  - Add to defaults object: `checkpoint: { autoOnSessionEnd: false, autoOnRoundComplete: false },`.
- `drone-core/src/config-schema.ts` — add a `checkpoint` TypeBox object matching the config.
- Run `pnpm -r run build` (dist is what dependents read).
- Agent: `code`. Depends on Phase 0 (ADR refs optional).

### Phase 2 — engine foundation + NDJSON stdin commands + mock sweep

Files:

- `drone-agent/src/runtime/plugin-engine.ts`
  - **Engine options:** add `sessionManager?: DroneSessionManager;` and `clearConversation?: () => void;` to `CreateDronePluginEngineOptions`; store both.
  - **Session id:** add engine option `sessionId?: string;` (host-seeded). Keep a mutable `let currentSessionId = sessionId ?? \`agent-${Date.now()}\``.
  - **Hook plumbing:** add `onSessionRecycle: []` to `createHookBuckets()`; add `onSessionRecycle: callback => hookBuckets.onSessionRecycle.push(callback)` (and keep `onSessionClear` wiring, now payload-aware) inside the `hooks: {}` block in `registerPlugin`.
  - **`_runtime`:** add `getSessionId: () => currentSessionId` (and keep other fields).
  - **New engine API `clearSession()`:** the clear boundary. Logic:
    ```ts
    async function clearSession(): Promise<void> {
      const turns = sessionManager?.getTurns() ?? [];
      const hadTurns = turns.length > 0;
      if (hadTurns)
        await runHooks('onSessionClear', { sessionId: currentSessionId });
      clearConversation?.();
      if (hadTurns) {
        const previousSessionId = currentSessionId;
        currentSessionId = `agent-${Date.now()}`;
        await runHooks('onSessionRecycle', {
          sessionId: currentSessionId,
          previousSessionId,
        });
      }
    }
    ```
    Add it to the returned engine object and to the `DronePluginEngine` type. (Reuse this single method for `/clear`, the import recycle step, AND the §0 `exportContext`/`importContext` stdin handlers.)
  - **Seed the capability:** in `initialize()`, right after the reference-capability seed, add:
    ```ts
    capabilities.set(
      DRONE_PORTABLE_CONTEXT_CAPABILITY_ID,
      createPortableContextCapability({
        sessionManager,
        listAllTools: () => toolRegistry.listAll(),
        listMountedTools: () => toolRegistry.listMounted(),
        mountTool: name => toolRegistry.mount(name),
        runHooks,
        clearSession,
        getSessionId: () => currentSessionId,
        emitEvent: dispatchConversationEvent,
        logger,
      })
    );
    ```
- `drone-agent/src/runtime/builtin-commands.ts` — `/clear` handler: replace `runHooks('onSessionClear')` + `conversation.clearSession()` with `await ctx.engine.clearSession()` (fall back to `ctx.conversation?.clearSession?.()` if absent). Add `clearSession?` to the slash-ctx engine handle type if needed.
- `drone-agent/src/interactive.ts` — §0: extend `InputEvent`; handle `exportContext`/`importContext` in `runJsonListenMode` BEFORE the `event.type !== 'chat'` branch, calling `engine.getCapability<DronePortableContextCapability>('portable-context')` and emitting `contextExport`/`contextImport` via the ndjson handler; no turn semantics. (See §0 for exact events.)
- `drone-agent/src/output-handlers.ts` — §0: extend `OutputEvent` union with the four `contextExport`/`contextImport` variants.
- **Mock sweep (required):** every hand-built `DronePluginHooks` literal must gain `onSessionRecycle: () => {},` (~53 sites under `drone-agent/test/`, e.g. `search.test.ts`, `compaction.test.ts`, `plugin-engine.test.ts`, provider tests' `hooks` objects which must also push to an array if they capture). Ground truth = `pnpm run typecheck`.
- Agent: `code` (impl) + `worker` (sweep). Depends on Phase 1.

### Phase 3 — portable-context capability implementation

Files:

- NEW `drone-agent/src/runtime/portable-context/capability.ts` — `createPortableContextCapability(deps)` implementing:
  - `registerContributor/unregisterContributor/getContributors` (Map keyed by `contributor.id`; last write wins, mirror reference-kind style).
  - `exportContext()`:
    ```ts
    const turns = sessionManager.getTurns();
    const session = {
      sourceSessionId: deps.getSessionId(),
      turns: turns.map(t => ({ kind: t.kind, messages: t.messages })),
    };
    const mounted = new Set(deps.listMountedTools().map(t => t.name));
    const tools = deps
      .listAllTools()
      .map(t => ({ ...t, mounted: mounted.has(t.name) }));
    const pluginData = {};
    for (const c of contributors.values()) {
      try {
        const v = await c.export({ turns });
        if (v !== undefined) pluginData[c.id] = v;
      } catch (e) {
        logger.warn(`portable-context export failed for ${c.id}: ${e}`);
      }
    }
    return {
      version: CURRENT_CONTEXT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      session,
      tools,
      pluginData,
    };
    ```
  - `importContext(data)`:
    1. Version check (`MIN..MAX`); throw on mismatch (no mutation).
    2. `await deps.clearSession()` (the boundary; self-gates on empty).
    3. Inject restored turns: `sessionManager.appendTurns(data.session.turns)` (new method, Phase 3 session-manager change).
    4. Restore contributors: for each contributor with `data.pluginData[c.id]` present → `await c.import(data.pluginData[c.id], { turns })` inside try/catch → warnings. Unknown keys → warning.
    5. Remount tools (additive; never unmount): for each `data.tools` entry with `mounted === true` that exists in the registry (`deps.mountTool(name)` returns a def) → mounted; collect names NOT in the registry into `unavailableTools`.
    6. Append the **continuation disclosure** turn (Phase 5 format below) as a stored user turn via `sessionManager.appendUserMessage(reminderText)`.
    7. Emit a non-stored `notice` conversation event (`deps.emitEvent({ kind: 'notice', content })`).
    8. Return `{ warnings, unavailableTools }`.
- `drone-agent/src/runtime/session-manager.ts` — add:
  ```ts
  appendTurns: (turns: Array<{ kind?: 'summary'; messages: DroneSessionMessage[] }>) => void;
  ```
  Push each as its own turn with a fresh `randomUUID()` id (reuse `createTurn`, pushing each message into its own turn object). Add to `DroneSessionManager` type.
- Agent: `code`. Depends on Phase 2.

### Phase 4 — contributors (`todo`, `focus`, `notepad`, `persona`)

Each plugin adds `{ id: DRONE_PORTABLE_CONTEXT_CAPABILITY_ID, optional: true }` to `metadata.dependencies`, then in `register()`:

```ts
const pc = registration.request<DronePortableContextCapability>(DRONE_PORTABLE_CONTEXT_CAPABILITY_ID);
pc?.registerContributor({ id: '<pluginId>', export: () => ({...}), import: data => {...} });
```

- `drone-agent/src/plugins/todo/index.ts` — export `{ items, nextId }`; import: clear `items`, push restored, set `nextId`.
- `drone-agent/src/plugins/focus.ts` — export `{ currentFocus }`; import: set `state.currentFocus`.
- `drone-agent/src/plugins/notepad.ts` — export `{ currentNotepad }`; import: set `state.currentNotepad`.
- `drone-agent/src/plugins/persona/index.ts` — export `{ personaId: activePersona?.id ?? null }`; import: if non-null, call the existing activation path (`activatePersona`/`selectPersona(id)`), which re-premounts the persona's tools and emits `personaChanged`. (Scope is not stored on the definition; restore resolves by provider precedence — document this in ADR 246.) NOTE: this ordering matters — persona re-premount happens _before_ Phase 3 step 5's additive remount, so the additive remount only adds back truly-missing tools.
- Agent: `code`. Depends on Phase 2.

### Phase 5 — `checkpoint` plugin

Files:

- NEW `drone-agent/src/plugins/checkpoint/index.ts` — `DronePlugin` (`id: 'checkpoint'`, `defaultEnabled: false`, dependency `{ id: DRONE_PORTABLE_CONTEXT_CAPABILITY_ID, optional: true }`).
  - Read `registration.request<DronePortableContextCapability>(DRONE_PORTABLE_CONTEXT_CAPABILITY_ID)`.
  - Offer `DroneCheckpointCapability` = `{ runStartupRestore }`.
  - Register `/checkpoint` slash command:
    - Usage: `/checkpoint create <name>` | `restore <name>` | `delete <name>` | `rename <old> <new>` | `list`. No subcommand → `create` with default name = filesystem-safe ISO timestamp (`new Date().toISOString().replace(/[:.]/g, '-')`).
    - `busyBehavior: inv => inv.subcommand !== 'restore'` (restore queued; everything else immediate).
  - Help snippets.
  - Hooks:
    - `onSessionClear(payload)` → if `config.checkpoint.autoOnSessionEnd`, write `auto-end-<payload.sessionId>-<timestamp>`.
    - `onShutdown` → if `autoOnSessionEnd`, write `auto-end-<getSessionId()>-<timestamp>`.
    - `onConversationEvent(e)` → if `e.kind === 'roundComplete'` and `autoOnRoundComplete`, increment a plugin-local ordinal and write `auto-round-<ordinal>-<getSessionId()>-<timestamp>`.
    - Auto-checkpoints accumulate (never overwrite); different sinks; non-mutating source → safe concurrent.
- NEW `drone-agent/src/plugins/checkpoint/store.ts` — helpers:
  - `checkpointDir()` = `path.join(process.cwd(), '.drone-agent', 'checkpoints')`.
  - `sanitizeName(name)`: allow `[A-Za-z0-9._-]`; reject empty / path separators / `..` (throw).
  - `writeCheckpoint(name, data)` → `mkdir -p` then tmp+rename atomic write of `<name>.json`.
  - `readCheckpoint(name)`, `deleteCheckpoint(name)`, `renameCheckpoint(old, new)` (read+write+unlink), `listCheckpoints()` (readdir `*.json`, strip ext).
- NEW `drone-agent/src/startup-checkpoint.ts` — mirror `startup-import.ts`: `runStartupCheckpointRestore(getCapability, logger, pluginFlags)`; reads `pluginFlags['checkpoint.restore']`; gets the `checkpoint` capability; calls `capability.runStartupRestore()`; returns `ChatEntry[] | undefined` (notice) for TUI seeding.
- `drone-agent/src/index.tsx` — after `runStartupSessionImport(...)`, call `runStartupCheckpointRestore(pluginId => engine.getCapability(pluginId), logger, invocation.options.pluginFlags)` and seed the TUI with its entries.
- `drone-agent/src/plugins/index.ts` — add `checkpointPlugin` to `staticBuiltInPlugins`.
- Agent: `code`. Depends on Phases 1, 2, 3.

### Phase 6 — swarm full re-cycle (highest risk)

Files:

- `drone-agent/src/plugins/swarm/index.ts`
  - Read session id from `_runtime.getSessionId()` instead of `userSwarmConfig.sessionId ?? config.sessionId ?? agent-<ts>`.
  - Replace `getAgentId: () => sessionId` with `() => ctx.sessionId`.
  - Register `onSessionRecycle`:
    ```ts
    registration.hooks.onSessionRecycle(async ({ sessionId: newId }) => {
      ctx.sessionId = newId;
      ctx.wsUrl = `${wsProtocol}://${beaconHost}:${beaconPort}/ws?agentId=${newId}`;
      // close old socket (if any), re-POST /agents, registerSwarmSession(ctx), reconnect WS
    });
    ```
  - Extract a `reconnectBeacon(ctx)` helper reused by initial connect and recycle.
- `drone-agent/src/plugins/swarm/context.ts` — `SwarmContext.sessionId` and `wsUrl` are already plain fields (mutable); document the recycle mutation.
- `drone-agent/src/plugins/swarm/websocket.ts` — ensure reconnect path is callable with a new `wsUrl` (guard against double-connect).
- Agent: `code`. Depends on Phase 2. Sequence LAST (after core + checkpoint proven).

### Phase 7 — tests

- Unit: `portable-context` export/import round-trip; version reject; unknown/missing pluginData; tools mounted-flags; tool remount additive + unavailable list; continuation disclosure turn content; empty-target gate skips recycle.
- Engine: `clearSession()` boundary order (`onSessionClear` → clear → mint → `onSessionRecycle`), empty gate, session-id mint.
- **NDJSON stdin (§0):** feed `{type:'exportContext'}` → assert a `contextExport` line with `ok:true` and a valid `context`; feed `{type:'importContext', context}` → assert `contextImport` `ok:true`, session mutated, and NO `turnComplete` emitted for either; bad `context`/version → `ok:false` with `error`.
- Contributors: todo/focus/notepad/persona export+import round-trips.
- `checkpoint` plugin: store sanitize/atomic write/list/rename/delete; slash subcommands; default timestamp name; auto-end/round naming templates; busyBehavior; `--checkpoint.restore` startup path.
- swarm recycle: new id, re-registration, WS URL change, `getAgentId()` updates.
- TUI: any new notice rendering uses `waitUntilFrame` polling (never fixed ticks).
- Agent: `tester` (+ `code` for fixes). Depends on Phases 2–6.

### Phase 8 — documentation

- `docs/agents/portable-context.md` — the capability, schema, contributor API, recycle contract, AND the §0 NDJSON stdin/wire commands.
- Update `AGENTS.md` hook list (add `onSessionRecycle`) + plugin table (add `checkpoint`).
- Update project wiki index/modules pages (drone-agent, drone-agent-plugins, and the json-listen-mode/ndjson wire page) + ADR stubs; keep `[[decisions/246…]]`/`[[decisions/247…]]` stubs.
- Agent: `code`. Depends on Phases 0–7.

### Phase 9 — final validation (REQUIRED)

Run and pass all gates in §6. Agent: `review`.

## 6. Validation criteria (all MUST pass)

1. **LSP clean** for touched files (drone-core, drone-agent) — no errors.
2. `pnpm -r run build` — zero errors (run BEFORE relying on cross-package typecheck; dependents read drone-core `dist/`).
3. `pnpm run lint` — zero errors (prettier reformats; re-read files before further edits).
4. `pnpm run typecheck` — zero errors, INCLUDING the full `onSessionRecycle` mock sweep (~53 hook literals).
5. `pnpm run test` (fast suite) — passes.
6. Feature-specific verification:
   - `exportContext()` → `importContext()` round-trips: turns restored with fresh ids, summaries inline, images verbatim, tools remounted additively, missing tools listed in the disclosure turn + `unavailableTools`.
   - Version outside `[MIN,MAX]` → rejected, session unchanged.
   - Recycle order proven by test: `onSessionClear` (session intact) → clear → new id minted → `onSessionRecycle` (empty session, new id).
   - Empty target import → no `onSessionClear`/`onSessionRecycle`, no id mint.
   - `--checkpoint.restore <name>` boots, restores before first turn, and does not fire recycle hooks (empty session).
   - `/checkpoint` create/restore/delete/rename/list behave; `restore` queues while busy, others run immediately; default name is a timestamp.
   - NDJSON stdin: `{type:'exportContext'}` → `contextExport`; `{type:'importContext'}` → `contextImport` with `ok/warnings/unavailableTools`; neither emits `turnComplete`; malformed input → `ok:false` + `error`.
   - swarms: after recycle, `getAgentId()` returns a NEW id and the beacon session re-registers.
7. `/swarm-session import` still works unchanged (regression check).
8. No dead code, no unused vars, no fluff comments (project standards). Files >1000 lines split.

## 7. Decision index (traceability)

- D1 engine-seeded capability `portable-context` (mirror `reference`).
- D2 schema v1 shape; turn/message ids not serialized; summaries inline; only summary system-messages survive.
- D3 contributor API `{ id, export, import? }`; soft import failures "for now".
- D4/D15 recycle contract = clear boundary; fresh id; `onSessionClear`→clear→mint→`onSessionRecycle`; empty gate; no `sessionStarted` event.
- D5 tools: export all + `mounted`; additive remount after restore; disclosure as persistent `<system-reminder>` turn.
- D6 contributors: todo, focus, notepad, persona. (No memory/skills/macros; no model/reasoning.)
- D7/D7b/D7c checkpoint plugin surface, storage, auto templates, `--checkpoint.restore` dotted flag.
- D8 images verbatim; swarm imports ride along.
- D9 engine gets `sessionManager` + `clearConversation`; engine owns recycle.
- D10 contributors declare `portable-context` optional dep + `request()`.
- D11 swarm full re-cycle (own phase).
- D12 engine owns `currentSessionId` (`_runtime.getSessionId()`).
- D13 merged continuation+missing-tools disclosure turn, exact structure:
  ```
  <system-reminder>
  The preceding was restored from a prior checkpoint taken from session <id> at <date and time>.

  <if any tools mounted in the old session are not currently available, list them here>
  </system-reminder>
  ```
- D14 version constants `MIN/MAX_CONTEXT_SCHEMA_VERSION`; unknown/missing pluginData handling.
- D16 NDJSON stdin/wire support: `{type:'exportContext'}` / `{type:'importContext', context}` input; `contextExport` / `contextImport` output; control commands (no turn semantics, no `turnComplete`); runJsonListenMode only; engine-seeded capability so no plugin required. (See §0.)


---

## Execution Summary — COMPLETE (2026-10-11, branch `feat/portable-context`)

All 9 phases executed; every validation gate passes.

### Commits
- `64f593cf` — P0 ADRs + P1 drone-core types + P2 engine foundation/NDJSON/mock sweep + P3 capability.
- `dd47a78c` — P4 contributors + P5 checkpoint plugin.
- `be5065a7` — P6 swarm full re-cycle.
- `84160cae` / `153acd4f` — P7 tests + agent doc.
- `ed29e359` — P8 docs (AGENTS.md, ADR index, wiki).
- `27f92d12` — lint fix (unused import) + prettier reformat.

### What landed
- **P1 (drone-core)**: `portable-context-types.ts` (schema v1, `MIN/MAX/CURRENT_CONTEXT_SCHEMA_VERSION=1`, contributor + capability types); `onSessionClear` payload + standard `onSessionRecycle` hook (+ `DroneSessionClearPayload`/`DroneSessionRecyclePayload`); `DroneCheckpointCapability`; `DroneCheckpointConfig` + defaults + schema + merge spec.
- **P2 (engine/wire)**: `engine.clearSession()` boundary (onSessionClear (session intact) → mechanical clear → mint → onSessionRecycle), empty-gated; engine-owned `currentSessionId` + `_runtime.getSessionId()` + `engine.getSessionId()`; `sessionManager`/`clearConversation`/`sessionId` engine options; `/clear` routed through the boundary; `portable-context` capability seeded BEFORE plugin registration; NDJSON `exportContext`/`importContext` control commands → `contextExport`/`contextImport` (no turn semantics, no `turnComplete`); ~53-site `onSessionRecycle` mock sweep (tsconfig.test.json is the ground truth).
- **P3**: `runtime/portable-context/capability.ts` + `sessionManager.appendTurns` (fresh ids).
- **P4**: contributors via `shared/portable-context-contributor.ts` — todo (snapshot, not a live alias), focus, notepad, persona (re-activates by id → re-premounts before the additive remount).
- **P5**: `checkpoint` plugin (`/checkpoint create|restore|delete|rename|list`; restore queued), atomic store (`./.drone-agent/checkpoints`, `sanitizeName`, tmp+rename), auto-end/auto-round checkpoints, `DroneCheckpointCapability.runStartupRestore`; `startup-checkpoint.ts` + `--checkpoint.restore` wiring.
- **P6 (swarm)**: reads `_runtime.getSessionId()`; `recycleSwarmSession` (re-POST /agents, re-register, close+reconnect WS); `buildWsUrl`; `onSessionRecycle` hook; `/swarm-session` reads the live id via a thunk.
- **P7**: `portable-context*.test.ts` (capability, engine boundary, NDJSON, contributors), `checkpoint-plugin.test.ts`, `swarm/recycle.test.ts`.
- **P8**: `docs/agents/portable-context.md`; AGENTS.md hook list + subsystem entry; ADR index rows; wiki ADR stubs + cross-links + json-listen-mode section.

### Validation (Phase 9) — all pass
- LSP clean; `pnpm -r run build` clean; `pnpm run lint` clean (prettier applied); `pnpm run typecheck` clean (incl. `tsconfig.test.json`).
- `pnpm run test` — **3876 passed / 14 skipped**.
- Feature checks covered by the new tests (round-trip, version reject + no mutation, recycle order, empty gate, `--checkpoint.restore`, `/checkpoint` surface, NDJSON commands, swarm new id + re-registration).
- `/swarm-session import` regression — `session-import.test.ts` (19) + `session-command.test.ts` (9) all pass.

### Notable corrections during execution
- The todo contributor's first `export` returned the live `items` array, so an in-process export→import round-trip cleared the array it was reading; fixed by snapshotting (`items.map(i => ({...i}))`). **Contributors must return snapshots, never live aliases.**
- ADR 247 records that the user-spec `--checkpoint-restore` was reconciled to the dotted `--checkpoint.restore` (the plugin-flag facility only parses `--<pluginId>.<flag>`).

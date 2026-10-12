# Portable Context

Portable context is a standardized, versioned JSON serialization of a session's
**context** (its turns, its tool catalog, and a plugin-extensible metadata map),
plus a **continuation** path that restores it as a **brand-new session**. See
[ADR 246](../../docs/adr/246-portable-context.md) for the design rationale and
[ADR 247](../../docs/adr/247-checkpoint-plugin.md) for the `checkpoint` plugin.

The capability is **engine-seeded** (mirroring `reference`) and **inert until a
plugin or host calls it** — it ships as dead code by default. Its consumers are
the opt-in `checkpoint` plugin and the `--output-json` NDJSON stdin commands
(below).

## Capability

`DRONE_PORTABLE_CONTEXT_CAPABILITY_ID = 'portable-context'`. The engine creates
the capability and `capabilities.set()`s it during `initialize()`, right after
the `reference` seed and **before** plugin registration. Contributors reach it
by declaring `{ id: 'portable-context', optional: true }` in plugin metadata and
calling `registration.request<DronePortableContextCapability>('portable-context')`.

```ts
type DronePortableContextCapability = {
  registerContributor(c: DronePortableContextContributor): void;
  unregisterContributor(id: string): void;
  getContributors(): DronePortableContextContributor[];
  exportContext(): Promise<DronePortableContextExport>;
  importContext(
    data: DronePortableContextExport
  ): Promise<DronePortableContextImportResult>;
};
```

## Schema (v1)

```ts
type DronePortableContextExport = {
  version: number; // MIN/MAX/CURRENT_CONTEXT_SCHEMA_VERSION === 1
  createdAt: string; // ISO
  session: {
    sourceSessionId?: string;
    turns: Array<{ kind?: 'summary'; messages: DroneSessionMessage[] }>;
  };
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: DroneToolJsonSchema;
    defaultHidden?: boolean;
    mounted: boolean;
  }>;
  pluginData: Record<string, unknown>; // keyed by plugin id
};
```

**Serialization rules:**

- **All session turns** are exported faithfully. Compaction summaries stay
  inline (`kind: 'summary'`). Every _other_ system message (system prompt,
  runtime flags, header/footer fragments) is omitted — those are regenerated
  per request and never live in the session manager.
- **Turn ids are not serialized**; import re-mints them with `randomUUID()`.
- **Images are exported verbatim** (full `DroneImageContent` including base64
  `data` and any `description`).
- The version is accepted iff `MIN_CONTEXT_SCHEMA_VERSION ≤ version ≤
MAX_CONTEXT_SCHEMA_VERSION`; otherwise the import rejects with a clear error
  and **does not mutate the session**.

## Contributor API

A plugin contributes a slice of `pluginData`:

```ts
type DronePortableContextContributor = {
  id: string; // the pluginData key (plugin id)
  export: (ctx: {
    turns: readonly DroneSessionTurn[];
  }) => unknown | Promise<unknown>;
  import?: (
    data: unknown,
    ctx: { turns: readonly DroneSessionTurn[] }
  ) => void | Promise<void>;
};
```

- A contributor's `undefined` return is skipped; a throw on export is caught and
  logged (the export still succeeds).
- On import, a contributor's throw is caught and pushed into `warnings[]` —
  **soft failures** (ADR 246 D3).
- Unknown `pluginData` keys → ignore + warn; missing keys → skip that
  contributor's import.

The initial contributors are `todo`, `focus`, `notepad`, and `persona`. Disk-backed
assets (`memory`, `skills`, `macros`) get no contributor — they are already
persistent. The persona contributor restores by id; **scope is not stored on the
definition**, so restore resolves by provider precedence. Persona re-activation
runs _before_ the additive remount, so the additive pass only adds back tools the
persona does not own.

Declare the dependency and register in `register()`:

```ts
metadata: { /* ... */, dependencies: [{ id: 'portable-context', optional: true }] },
register: async registration => {
  registerPortableContextContributor(registration, {
    id: 'my-plugin',
    export: () => ({ /* snapshot, not a live alias */ }),
    import: data => { /* restore */ },
  });
},
```

## The recycle contract (the clear boundary)

`engine.clearSession()` is the session boundary **and** the session-id generator.
Its order is engine-owned, so no plugin depends on hook registration order:

1. `runHooks('onSessionClear', { sessionId: oldId })` — the outgoing session is
   **intact** (turns present, old id).
2. `clearConversation()` — drain queues/steers/reminders, reset guardrail
   counters, empty turns.
3. The engine **mints a fresh `currentSessionId`**.
4. `runHooks('onSessionRecycle', { sessionId: newId, previousSessionId: oldId })`
   — the new session is empty; the swarm re-registers under the new id.

**Empty gate:** steps 1/3/4 run only when the outgoing session has ≥1 turn. An
empty clear is purely mechanical. `/clear` routes through `engine.clearSession()`
and now mints a new id (when the session was non-empty).

`onSessionRecycle` is a standard hook. `onSessionClear`'s payload is optional, so
existing zero-arg subscribers stay valid.

## Engine-owned session id

The host seeds the session id (`--session-id` → `DRONE_SESSION_ID` →
`agent-<Date.now()>` fallback). It is exposed via `_runtime.getSessionId()` and
`engine.getSessionId()`. The swarm plugin **reads** it instead of minting
privately; recycle mints a fresh one. The swarm's `onSessionRecycle` callback
re-POSTs `/agents`, re-registers the swarm session, closes the stale WebSocket,
and reconnects on the new URL (`wsUrl` is rebuilt from the new id).

## Import orchestration

`importContext(data)` on the capability runs the full sequence, so consumers
never need to know it:

1. Version check (reject on mismatch, no mutation).
2. `clearSession()` (the boundary; self-gates on empty).
3. Inject restored turns via `sessionManager.appendTurns(turns)` (fresh ids).
4. Restore contributors (per-contributor try/catch → warnings; unknown keys
   warned, missing keys skipped). **Persona re-activation runs here.**
5. Remount tools **additively** (never unmount): for each `tools[]` entry with
   `mounted === true` that still exists in the registry, `mountTool(name)`;
   names not in the registry are collected into `unavailableTools`.
6. Append the **continuation disclosure** as a stored user turn:

   ```
   <system-reminder>
   The preceding was restored from a prior checkpoint taken from session <id> at <date and time>.

   <if any tools mounted in the old session are not currently available, list them here>
   </system-reminder>
   ```

7. Emit a non-stored `notice` conversation event.
8. Return `{ warnings, unavailableTools }`.

## NDJSON stdin/wire commands

Portable context is drivable over the `--output-json` stdin NDJSON protocol
(`runJsonListenMode`) so the gateway can export/import over the child-process
wire **without a plugin** (the capability is engine-seeded).

**Input** events (extend `InputEvent` in `drone-agent/src/interactive.ts`):

```jsonc
{ "type": "exportContext" }
{ "type": "importContext", "context": { /* DronePortableContextExport */ } }
```

**Output** events (extend `OutputEvent` in `drone-agent/src/output-handlers.ts`):

```jsonc
{ "kind": "contextExport", "ok": true, "context": { /* ... */ } }
{ "kind": "contextExport", "ok": false, "error": "..." }
{ "kind": "contextImport", "ok": true, "warnings": [], "unavailableTools": [] }
{ "kind": "contextImport", "ok": false, "error": "..." }
```

These are **control commands on the same stdin stream — not turns**: they never
run `onBeforePrompt`/`onAfterToolCall` and never emit `turnComplete`; they are
handled _before_ the `event.type !== 'chat'` rejection branch. `importContext`
runs the full orchestration (recycle → restore → remount → disclosure), exactly
like `/checkpoint restore`. Any failure surfaces as `{ ok: false, error }`, never
a crash. Scope is `runJsonListenMode` only — `runSwarmListenMode` reads no stdin.

## The `checkpoint` plugin

`defaultEnabled: false`. Storage: `./.drone-agent/checkpoints/<name>.json`
(atomic tmp+rename writes; names validated to `[A-Za-z0-9._-]`).

| Command                          | Behavior                                                        |
| -------------------------------- | --------------------------------------------------------------- |
| `/checkpoint create [name]`      | Save a checkpoint (default name: filesystem-safe ISO timestamp) |
| `/checkpoint restore <name>`     | Restore into a fresh session (**queued** while the LLM is busy) |
| `/checkpoint delete <name>`      | Delete a checkpoint                                             |
| `/checkpoint rename <old> <new>` | Rename a checkpoint                                             |
| `/checkpoint list`               | List checkpoints                                                |

CLI flag: **`--checkpoint.restore <name>`** (the dotted plugin-flag convention;
auto-enables the plugin). It runs after `--swarm.session-import` and before the
first turn; since the target session is empty, the import's recycle step is a
no-op.

Auto-checkpoints (`checkpoint.autoOnSessionEnd`, `checkpoint.autoOnRoundComplete`,
both default false) accumulate with distinct names:
`auto-end-<sessionId>-<timestamp>` (on `onSessionClear` / `onShutdown`) and
`auto-round-<ordinal>-<sessionId>-<timestamp>` (on `roundComplete`).

Config schema: `checkpoint: { autoOnSessionEnd: boolean; autoOnRoundComplete: boolean }`.

## Non-goals

- `swarm-checkpoint` (swarm-stored checkpoints) — future.
- herdr / gateway consumers beyond the NDJSON commands — future.
- `/swarm-session import <id>` is unchanged; its summaries are ordinary session
  turns and ride into a portable export for free.

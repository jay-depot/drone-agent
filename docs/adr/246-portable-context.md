---
tags:
  [
    decision,
    portable-context,
    checkpoint,
    session,
    capability,
    plugin-system,
    hooks,
    ndjson,
    gateway,
    adr,
  ]
related:
  [
    decisions/247-checkpoint-plugin.md,
    decisions/218-reference-expansion-and-tab-completion.md,
    decisions/221-reference-expansion-host-wiring.md,
    decisions/198-coordinator-ui-launch-interact.md,
    decisions/146-swarm-session-import.md,
    decisions/192-session-param-events.md,
    concepts/session-management.md,
    concepts/json-listen-mode.md,
    modules/drone-agent.md,
    modules/drone-core.md,
    modules/drone-agent-plugins.md,
  ]
---

# 246: Portable context — versioned session-context serialization + session-recycle continuation

**Status**: Implemented (2026-10-11) · **Branch**: `feat/portable-context` · **Plan**: project-memory `plan-portable-context`

**Summary**: Portable context is a standardized, versioned JSON serialization of a session's **context** (its turns + tool catalog + a plugin-extensible metadata map) plus a **continuation** path that restores it as a **brand-new session**. The capability is **engine-seeded** (`portable-context`, mirroring `reference`) and **inert until a plugin or host calls it** — it ships as dead code by default, with no core consumer. The first consumer is an opt-in `checkpoint` plugin ([247](247-checkpoint-plugin.md)); a second consumer is the `--output-json` NDJSON stdin protocol (§6), so the gateway can export/import a context over the child-process wire without any plugin.

## Context

Nothing serializes a live session's context. The log plugin writes turns (sans system messages) to `~/.drone-agent/logs/`, but that is an audit artifact, not a restorable snapshot. `/swarm-session import` ([146](146-swarm-session-import.md)) recreates the context of an _old swarm_ session by summarizing its transcript, but it does not capture a live session's own turns, its mounted-tool state, or plugin-owned session state (todo list, focus, notepad, active persona). There was no way to snapshot a session and resume it later, in another process, or on another machine.

Two design constraints shaped the solution:

- The engine already seeds a capability (a registry consumed by plugins and the host) **before** plugin registration — the `reference` capability ([218](218-reference-expansion-and-tab-completion.md), [221](221-reference-expansion-host-wiring.md)). That precedent makes an engine-seeded capability the natural home for a feature that both plugins and the host (the NDJSON listen mode) must reach.
- "Continuation" must be a **new session**, not a resume of the old one. The swarm keys its transcript on the session id and re-registers `POST /agents` on it; a resumed context that kept the old id would silently merge two transcripts. So continuation is a **session recycle**: fresh id, fresh registration, fresh transcript.

## Decision

**1. Engine-seeded capability `portable-context`.** `DRONE_PORTABLE_CONTEXT_CAPABILITY_ID = 'portable-context'`. The engine creates the capability and `capabilities.set()`s it during `initialize()`, right after the `reference`-capability seed and **before** plugin registration. Contributors reach it by declaring `{ id: DRONE_PORTABLE_CONTEXT_CAPABILITY_ID, optional: true }` in plugin metadata and calling `registration.request<DronePortableContextCapability>(...)` — the same pattern the skills plugin uses for `reference`. Like `reference`, it is a default-installed, always-present capability; with no contributor registered and no caller, it does nothing.

**2. Schema v1.**

```ts
type DronePortableContextExport = {
  version: number;
  createdAt: string; // ISO
  session: {
    sourceSessionId?: string;
    turns: Array<{ kind?: 'summary'; messages: DroneSessionMessage[] }>;
  };
  tools: DronePortableContextTool[]; // { name, description, inputSchema?, defaultHidden?, mounted }
  pluginData: Record<string, unknown>; // keyed by plugin id
};
```

The export contains **all session turns, faithfully**, including compaction summaries inline (`kind: 'summary'`). Every **other** system message (system prompt, runtime flags, header/footer fragments) is omitted — those are regenerated per request and never live in the session manager, so no filtering is required; the summaries are the _only_ `role: 'system'` messages that survive. Turn ids are dropped on export and re-minted (`randomUUID()`) on import. **Images are exported verbatim** — full `DroneImageContent` including base64 `data` and `description` — because a checkpoint is a snapshot, and a re-described image is not the same context. `/swarm-session import`'s summaries need no special handling: they already live in the session as ordinary turns, so they ride into an export for free.

**3. Version constants.** `MIN_CONTEXT_SCHEMA_VERSION = 1`, `MAX_CONTEXT_SCHEMA_VERSION = 1`, `CURRENT_CONTEXT_SCHEMA_VERSION = 1` in `drone-core`. Import accepts a payload iff `MIN ≤ version ≤ MAX`; otherwise it rejects with a clear error and **does not mutate the session**. Future versions bump the numbers.

**4. Contributor API.** A plugin contributes a slice of `pluginData`:

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

`registerContributor`/`unregisterContributor`/`getContributors` are a `Map` keyed on `id` (last write wins). On export, a contributor's `undefined` return is skipped; a throw is caught and logged (the export still succeeds). On import, a contributor's throw is caught and pushed into `warnings[]` — **soft failures, for now** (revisit after real-world use). Unknown `pluginData` keys → ignore + warn; missing `pluginData` keys → skip that contributor's import. The initial contributors are `todo`, `focus`, `notepad`, and `persona`. Disk-backed assets (`memory`, `skills`, `macros`) get no contributor — they are already persistent; model/reasoning-level and swarm fragments are not exported.

**5. The recycle contract = the clear boundary.** `clearSession()` is the session boundary **and** the session-id generator. Its order is engine-owned, so no plugin depends on hook registration order:

1. `runHooks('onSessionClear', { sessionId: oldId })` — the outgoing session is **intact** (turns present, old id). This is where a checkpoint's auto-end snapshot is taken.
2. `conversation.clearSession()` — drain queues/steers/reminders, reset guardrail counters, empty turns.
3. The engine **mints a fresh `currentSessionId`**.
4. `runHooks('onSessionRecycle', { sessionId: newId, previousSessionId: oldId })` — the new session is empty; the swarm re-registers under the new id.

**Empty gate:** steps 1/3/4 run only when the outgoing session has ≥1 turn. If the outgoing session is empty, only the mechanical clear (step 2) runs — no hooks, no mint. This subsumes "skip recycle when the import target is empty": importing into an empty session does not spawn a pointless new swarm session or fire a spurious `onSessionClear`. `/clear` now also mints a new id and fires `onSessionRecycle` (when the session was non-empty). `onSessionRecycle` is a **standard hook**; `onSessionClear`'s payload is optional so existing zero-arg subscribers stay valid. No `sessionStarted` event is emitted — the swarm owns its identity in its own `onSessionRecycle` callback.

**6. Engine owns the session id.** The host seeds `sessionId` (`--session-id` → `DRONE_SESSION_ID` → `agent-<Date.now()>` fallback), moved out of the swarm plugin. It is exposed via `_runtime.getSessionId()`. The swarm plugin **reads** it instead of minting privately; recycle mints a fresh one. Because `_runtime` is always present, export/import and the checkpoint plugin work with the swarm disabled.

**7. Import orchestration.** `importContext(data)` lives on the capability, so consumers never need to know the sequence:

1. Version check (reject on mismatch, no mutation).
2. `clearSession()` (the boundary; self-gates on empty).
3. Inject restored turns via a new `sessionManager.appendTurns(turns)` (each turn gets a fresh `randomUUID()` id).
4. Restore contributors (per-contributor try/catch → warnings; unknown keys warned, missing keys skipped). **Persona re-activation runs here**, so its tool re-premount happens _before_ step 5's additive remount.
5. Remount tools **additively** (never unmount): for each `tools[]` entry with `mounted === true` that still exists in the registry, `mountTool(name)`; names not in the registry are collected into `unavailableTools`. Runtime meta-tools and the fresh persona premount are left intact.
6. Append the **continuation disclosure** as a stored user turn — a persistent `<system-reminder>` turn (not a fading one-turn notice; the model keeps retrying non-existent tools otherwise):

   ```
   <system-reminder>
   The preceding was restored from a prior checkpoint taken from session <id> at <date and time>.

   <if any tools mounted in the old session are not currently available, list them here>
   </system-reminder>
   ```

   The missing-tools list is the diff of `checkpoint.tools[]` (`mounted: true`) against the current registry.

7. Emit a non-stored `notice` conversation event, so the user sees the restore in the chat log.
8. Return `{ warnings, unavailableTools }`.

**8. NDJSON stdin/wire commands.** Portable context is drivable over the `--output-json` stdin NDJSON protocol (`runJsonListenMode`) so the gateway can export/import over the child-process wire without a plugin. New **input** events `{ type: 'exportContext' }` and `{ type: 'importContext'; context }`; new **output** events `contextExport` (`{ ok: true; context }` / `{ ok: false; error }`) and `contextImport` (`{ ok: true; warnings; unavailableTools }` / `{ ok: false; error }`). These are **control commands on the same stdin stream — not turns**: they never call `onBeforePrompt`/`onAfterToolCall` and never emit `turnComplete`; they are handled _before_ the `event.type !== 'chat'` rejection branch. `exportContext` calls the engine-seeded capability's `exportContext()`; `importContext` calls `importContext(event.context)` and runs the full orchestration (recycle → restore → remount → disclosure), exactly like `/checkpoint restore`. Any failure (bad `context`, version mismatch, missing capability) surfaces as `{ ok: false, error }`, never a crash. Scope is **`runJsonListenMode` only** — `runSwarmListenMode` reads no stdin and the swarm WS path is untouched.

**9. Checkpoint's startup restore fires before the first turn, on an empty session.** `--checkpoint.restore <name>` runs after `--swarm.session-import` and before the first turn; the target session is empty, so the import's recycle step is a no-op (empty gate) and no `onSessionClear`/`onSessionRecycle` fires.

## Alternatives considered

- **Export at the conversation-service seam** (a method on `conversationService`). Rejected: `reference` established that engine-seeded capabilities are how plugins and the host share cross-cutting concerns; a conversation-service method would put plugin-owned state (todo/focus) out of reach without a second registration path.
- **A plugin-registered capability** (e.g. a `portable-context` plugin offering the capability). Rejected: the NDJSON commands (§8) must work **without any plugin**; engine-seeding is the only way to guarantee the capability is present.
- **`onSessionStart` for the recycle notification.** Rejected: `onSessionStart` runs config-underlay rebuild / first-run banner / persona activation — re-firing it mid-session would double-apply startup effects. A distinct `onSessionRecycle` hook covers exactly "the session id changed".
- **Keeping the old session id on continuation.** Rejected: the swarm keys its transcript on the id; a reused id merges two transcripts. Lineage is preserved as `session.sourceSessionId`.
- **Filtering system messages from the export.** Rejected: unnecessary — system prompt / flags / fragments live outside the session manager, so the only `role: 'system'` turns present are summaries, which are wanted.
- **A fading one-turn unavailable-tools notice.** Rejected: the model re-attempts the missing tools once the notice scrolls out of recent context; a persistent `<system-reminder>` turn keeps the constraint in history.
- **Re-describing images on export (or dropping base64).** Rejected: a checkpoint is a faithful snapshot; verbatim images are the honest representation.

## Consequences

- The feature is dead code by default: with no contributor and no caller, the capability is inert. The `checkpoint` plugin ([247](247-checkpoint-plugin.md)) and the §8 NDJSON commands are its first consumers.
- `DronePluginHooks` gains `onSessionClear` (now payload-aware) and `onSessionRecycle`. Because `onSessionRecycle` is a **required** member, every hand-built `DronePluginHooks` literal (≈53 test sites) gains it — the typecheck gate is the ground truth for the sweep.
- `DronePluginEngine` gains `clearSession()` and the `sessionManager`/`clearConversation` construction options; `/clear` routes through `engine.clearSession()`.
- `DroneSessionManager` gains `appendTurns()`.
- `/clear` behavior changes: a non-empty clear now mints a fresh session id and fires `onSessionRecycle`; an **empty** clear no longer fires `onSessionClear` (only the mechanical clear runs).
- The swarm plugin ([247](247-checkpoint-plugin.md) sibling) converts to full re-cycle: it reads `_runtime.getSessionId()`, and its `onSessionRecycle` re-mints the id, re-POSTs `/agents`, re-registers the swarm session, and re-opens the WebSocket.
- `/swarm-session import` is unchanged: its summaries are ordinary turns and ride into an export for free.

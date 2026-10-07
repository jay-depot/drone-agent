---
tags: [decision, plugin, wakelock, power-management, conversation-service]
related: [modules/drone-agent-plugins.md, entities/Session.md, flows/tool-call-loop.md, concepts/session-management.md, decisions/160-unified-llm-error-retry-semantics.md]
---

# 169: Wakelock Plugin

**Status**: Implemented (2026-08-28)

## Context

A long-running coding agent (like drone-agent) can be working on a user request for minutes at a time while the user steps away. If the host machine's idle/sleep timer fires mid-round, the agent's work is suspended mid-flight — a poor experience and potentially a lost or corrupted turn. Most OSes expose a mechanism to temporarily inhibit system sleep (macOS `caffeinate`, Linux `systemd-inhibit`, Windows `SetThreadExecutionState`), but they are platform-specific shell commands, not a shared API.

We wanted a **platform-agnostic wakelock** that acquires sleep-inhibition while the agent is "actually working" and releases it as soon as the agent sends a final response. The approach is deliberately the same as opencode's ecosystem plugins: **shell out to the platform's native inhibitor command** rather than bundling native bindings or a compiled helper. But the activation model differs — rather than a long-lived "app is open" latch, the lock should track round activity precisely.

## Decision

Add a `wakelock` built-in plugin (opt-in, `defaultEnabled: false`) that holds a sleep-inhibition lock while a **round** is in flight and releases it when the round completes.

### 1. A "round" is the unit of work

A **round** is one `sendUserMessage` call — the full user-prompt → agent-final-reply lifecycle (`conversation-service.ts:453`), which internally loops over many LLM calls + tool batches. This is distinct from a "turn" (one LLM call / tool batch within a round).

### 2. Round start/end signals: `userMessage` event + new `roundComplete` event

- **Round start** = the existing `userMessage` `DroneConversationEvent`, already emitted via `engine.runConversationEventHooks` at the top of every `sendUserMessage`.
- **Round end** = a **new `roundComplete` event kind** added to the `DroneConversationEvent` union. It is emitted in a `try/finally` wrapping the entire `sendUserMessage` body, so it fires on **every** exit path: the normal no-tool-calls return, the `shouldStopLoop` early-return (subagent stop), the `CANCEL_SENTINEL` cancellation return, the broken-response `return ''`, and all throws (tool-depth limit, identical-call abort, stuck-error abort). The `finally` guarantees release even on a thrown error.

> **Why `roundComplete` and not the existing `assistantMessageComplete`?** `assistantMessage`/`assistantMessageComplete` fire for **both** intermediate tool-call assistant text and the final reply — they cannot distinguish the final response from the event stream alone. Only the return value of `sendUserMessage` (or a dedicated event) reliably marks round completion. A new event kind keeps the plugin self-contained (a single `onConversationEvent` subscription) rather than coupling it to host files that wrap `sendUserMessage`.

### 3. Boolean state machine in-process (not a refcount)

The plugin uses a **boolean `working` flag**, not a refcount. Reason: `drainPendingMessages()` emits a `userMessage` event for **every** queued message before the prompt's own `userMessage`, so a single round can emit N `userMessage` events but exactly one `roundComplete`. A refcount would over-increment and never return to zero (a lock leak). Rounds are strictly serialized per engine, so no concurrency guard is needed. The transitions are idempotent:

- on `userMessage` → `working = true`; if it was `false`, spawn the inhibitor
- on `roundComplete` → `working = false`; if it was `true`, kill the inhibitor

### 4. Per-process inhibitor, zero cross-process coordination

The OS keeps the machine awake while **any** independent inhibitor is held. So each process spawns its own long-lived inhibitor child and kills it to release; no shared state, lockfiles, or coordination:

| Platform | Command | Semantics |
|----------|---------|-----------|
| macOS | `caffeinate -i` | One `IOPMAssertion` per instance; refcounted system-wide, released on process exit |
| Linux | `systemd-inhibit --what=idle:sleep sleep infinity` | One inhibitor entry per process, auto-released on exit |
| Windows | (no-op in v1) | `SetThreadExecutionState` is per-thread not a refcount; deferred to a later shim |

- **Subagents never acquire the lock.** A subagent (child process spawned via `--subagent-id`/`DRONE_SUBAGENT_ID`) checks `_runtime.isSubagent` and returns during `register()`. Meanwhile the **parent** holds its own lock while blocked on the subagent round, so the machine stays awake without any coordination.
- **WSL is detected** via `/proc/version` containing "microsoft"/"WSL": `systemd-inhibit` runs there but only inhibits the guest, not the Windows host — so it's a no-op with one logged warning.
- **Unavailable/unsupported command** → no-op + log, never crashes the agent.

### 5. Config and defaults

- Plugin metadata `defaultEnabled: false` — opt-in to install/register the plugin (no surprise power behavior).
- `wakelock.enabled` config flag defaults to `true` — once the plugin is active, it just works; the flag is a kill-switch.
- New `DroneWakelockConfig = { enabled: boolean }`, added to `DroneAgentConfig`/`PartialDroneAgentConfig`, the `CONFIG_MERGE_SPEC` `merge` array, the schema, and `createDefaultAgentConfig`.

### 6. `roundComplete` is a silent control signal (deliberate deviation)

Per AGENTS.md's "emit events for background work" rule, new event kinds normally need a theme color + a TUI render case. **`roundComplete` deliberately does not**: it is a high-frequency control signal with no message. It is added to the `DroneConversationEvent` union **without** a theme color or TUI render case, so the non-exhaustive consumers (`tui/app.tsx`, `output-handlers.ts`) silently ignore it while it still flows to `onConversationEvent` subscribers. The wakelock plugin also mutates no session state and has no `emitEvent` path (it's a static built-in), so it is logger-only by default, with an optional `--debug wakelock` subsystem (via the existing `_runtime.flags` `DebugFlagRegistry`) for acquire/release + WSL/unavailable transition logging.

## Key Points

- New opt-in `wakelock` plugin holds a sleep-inhibition lock while a round is in flight and releases it when the round completes.
- Round start = `userMessage` event; round end = new `roundComplete` event emitted in a `try/finally` around `sendUserMessage` (fires on all exit paths, including throws).
- **Boolean state machine, not a refcount** — robust to the N-`userMessage`/1-`roundComplete` asymmetry from `drainPendingMessages()`.
- **Per-process inhibitor, zero cross-process coordination** — OS refcounts; machine sleeps only when the last inhibitor is released.
- Subagents skip acquiring; the parent holds the lock during a blocked subagent round.
- macOS `caffeinate -i`, Linux `systemd-inhibit --what=idle:sleep sleep infinity`; Windows deferred; WSL no-op + warning; unavailable command never crashes.
- `defaultEnabled: false` plugin + `wakelock.enabled` config defaulting `true`.
- `roundComplete` is a silent control signal — no TUI/theme rendering.
- Validation: `pnpm -r run build`, `pnpm lint`, `pnpm typecheck`, and the fast suite (2321 passed / 9 skipped) all pass; 11 new unit tests.

> **CORRECTED by [170-wakelock-debug-flag-lint-reenable](170-wakelock-debug-flag-lint-reenable.md) (2026-08-28):** the original `--debug wakelock` mechanism described here — via `_runtime.flags` (`DebugFlagRegistry`) — was **broken at runtime**. `_runtime.flags` is a `RuntimeFlagRegistry` (key/value system-prompt state) with no `isEnabled` method; `runtime.flags.isEnabled('wakelock')` threw a swallowed `TypeError` on every acquire/release, so `--debug wakelock` silently did nothing. ADR 170 exposes the real shared `DebugFlagRegistry` as a new additive `debugFlags` field on `_runtime`, and the plugin reads `runtime.debugFlags.isEnabled('wakelock')` (a real-engine regression test added). After the fix the fast suite is 2325 passed / 9 skipped.

## Related

- [drone-agent-plugins](../../drone-agent/src/plugins/) — Where the wakelock plugin lives (session & memory category)
- [Session](../../drone-core/src/session-types.ts) — `DroneConversationEvent` (the new `roundComplete` kind)
- tool-call-loop — Where `roundComplete` is emitted in the `sendUserMessage` loop
- session-management — Round vs turn lifecycle
- [160-unified-llm-error-retry-semantics](160-unified-llm-error-retry-semantics.md) — The `error`/`notice` event conventions around the loop
- [115-subagent-mode-and-return-tool](115-subagent-mode-and-return-tool.md) — Subagent spawning and `_runtime.isSubagent`
- [170-wakelock-debug-flag-lint-reenable](170-wakelock-debug-flag-lint-reenable.md) — Corrects the `--debug wakelock` mechanism + the project-wide lint re-enablement

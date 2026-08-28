---
key: wakelock-plugin-plan
tags:
  []
created: 2026-08-28T14:58:37.137Z
updated: 2026-08-28T15:00:16.229Z
---

# Wakelock Plugin — Implementation Plan

Platform-agnostic sleep-inhibition plugin for drone-agent. Acquires sleep-inhibition when the agent "actually starts working" and releases as soon as the agent sends a final response. Mirrors opencode's shell-out approach (no native libs) with a different activation model. Subagents never acquire the lock.

## Design (decisions resolved during planning)
- **Round** = one `sendUserMessage` call (user prompt → final reply). Round-start = `userMessage` event; round-end = NEW `roundComplete` event kind.
- Single `onConversationEvent` subscription: acquire on `userMessage`, release on `roundComplete`.
- **In-process = boolean state machine** (NOT refcount): drainPendingMessages() emits N `userMessage` events per round but exactly one `roundComplete`; a refcount would leak. Idempotent acquire (working=false→true spawns inhibitor) / release (working=true→false kills it).
- **Multi-instance**: per-process inhibitor, ZERO cross-process coordination. OS refcounts (systemd-inhibit per-process; caffeinate IOPMAssertion; SetThreadExecutionState per-thread). Machine sleeps only when last inhibitor released. Subagents skip acquiring; parent holds lock during blocked round.
- **Platform**: macOS `caffeinate -i`, Linux `systemd-inhibit --what=idle:sleep ... sleep infinity`. Windows = no-op (deferred). WSL via /proc/version "microsoft"/"WSL" → no-op + logged warning. Command unavailable → no-op + log, never crash.
- **Config/defaults**: plugin metadata `defaultEnabled: false`; `wakelock.enabled` config flag defaults to `true`.
- **TUI**: `roundComplete` added to union but NO theme color / NO render case (silent control signal; consumers are non-exhaustive switches → safely ignored).
- **Observability**: silent by default (logger-only). Optional `--debug wakelock` subsystem via `_runtime.flags.isEnabled('wakelock')` (DebugFlagRegistry, no new wiring). Log acquire/release + WSL/unavailable transitions when enabled.
- **Wiring**: no engine deps → `staticBuiltInPlugins[]`.

## Files touched
1. `drone-core/src/config-types.ts` — add `DroneWakelockConfig { enabled: boolean }`; add `wakelock: DroneWakelockConfig` to `DroneAgentConfig`; `wakelock: Partial<DroneWakelockConfig>` to `PartialDroneAgentConfig`; add `'wakelock'` to CONFIG_MERGE_SPEC `merge` array; default `wakelock: { enabled: true }` in `createDefaultAgentConfig` base.
2. `drone-core/src/config-schema.ts` — add `wakelock: Type.Object({ enabled: Type.Optional(Type.Boolean()) })` to `PartialDroneAgentConfigSchema` (after `search`/before `swarm`).
3. `drone-core/src/session-types.ts` — add `| { kind: 'roundComplete' }` to `DroneConversationEvent` union (+ doc comment noting it's a silent control signal, no TUI rendering).
4. `drone-core/src/index.ts` — re-export `DroneWakelockConfig` type.
5. `drone-agent/src/runtime/conversation-service.ts` — wrap `sendUserMessage` body in try/finally; in finally emit `{ kind: 'roundComplete' }` via `engine.runConversationEventHooks(...)` fire-and-forget with `.catch` swallow (mirror the existing userMessage emit at line 453). Fires on ALL exit paths (normal return, shouldStopLoop, CANCEL_SENTINEL, broken-response `return ''`, tool-depth/identical-call/stuck throws).
6. `drone-agent/src/plugins/wakelock/index.ts` (new) — the plugin.
7. `drone-agent/src/plugins/index.ts` — import + add `wakelockPlugin` to `staticBuiltInPlugins[]`.
8. `drone-agent/test/wakelock-plugin.test.ts` (new) — unit tests.
9. `docs/agents/debug-flag.md` — add `wakelock` row to "Current Subsystems" table.
10. `AGENTS.md` (optional) — add wakelock to plugin list + note roundComplete silent-signal deviation.

## Plugin implementation (step 6 sketch)
```ts
import { spawn, type ChildProcess } from 'node:child_process';
import type { DronePlugin } from 'drone-core';

type RuntimeInfo = { isSubagent: boolean; flags: { isEnabled(name: string): boolean } };

export const wakelockPlugin: DronePlugin = {
  metadata: {
    id: 'wakelock', name: 'Wakelock', version: '0.1.0',
    description: 'Prevents the host machine from sleeping while the agent is working.',
    defaultEnabled: false,
  },
  register: async registration => {
    const config = registration.getConfig().wakelock;
    const runtime = registration.request<RuntimeInfo>('runtime');
    if (runtime?.isSubagent) return; // subagents never acquire
    if (!config?.enabled) return;

    // Resolve platform command once at register:
    //   darwin -> { cmd: 'caffeinate', args: ['-i'] }
    //   linux  -> { cmd: 'systemd-inhibit', args: ['--what=idle:sleep', 'sleep', 'infinity'] }
    //   WSL    -> log warning once, return (no-op)
    //   other  -> return (no-op)

    let working = false;
    let inhibitor: ChildProcess | null = null;
    const debug = () => runtime?.flags.isEnabled('wakelock');

    const acquire = () => {
      if (working || !cmd) return;        // idempotent
      working = true;
      try {
        inhibitor = spawn(cmd, args, { stdio: 'ignore' });
      } catch (err) {                    // ENOENT / unavailable
        working = false;
        if (debug()) registration.logger.warn(`wakelock unavailable: ${err}`);
        return;                          // never crash the agent
      }
      if (debug()) registration.logger.info('wakelock acquired');
    };
    const release = () => {
      if (!working) return;
      working = false;
      inhibitor?.kill();
      inhibitor = null;
      if (debug()) registration.logger.info('wakelock released');
    };

    registration.hooks.onConversationEvent(async ev => {
      if (ev.kind === 'userMessage') acquire();
      else if (ev.kind === 'roundComplete') release();
    });
    registration.hooks.onShutdown(async () => {
      inhibitor?.kill();
      inhibitor = null;
    });
    registration.registerHelp('Wakelock: prevents host sleep while working. Enable via wakelock.enabled or enabling the wakelock plugin.');
  },
};
```
Notes: spawn ENOENT throws synchronously → try/catch works; also attach `'error'` listener. WSL check is one-time at register (async read /proc/version).

## Test cases (step 8)
1. `defaultEnabled === false` in metadata.
2. register() in subagent mode (runtime.isSubagent=true) → no spawn attempt.
3. register() with wakelock.enabled=false → no spawn attempt.
4. userMessage event → spawns inhibitor (mock spawn); second userMessage → still one child (idempotent).
5. userMessage then roundComplete → child killed.
6. roundComplete without userMessage → no-op (no crash).
7. unavailable command (spawn throws ENOENT) → no-op + no throw, working stays safe.
8. WSL detection (mock /proc/version) → warning logged, no spawn.
9. onShutdown with live inhibitor → killed.
10. Mock `_runtime.flags.isEnabled('wakelock')` toggles debug logging on/off.
Tests use a mock registration object (mock getConfig, logger, request, hooks) calling register() directly, mocking `node:child_process` spawn (vi.mock) and /proc/version read.

## Validation criteria
- LSP passes (typescript) for all touched files.
- `pnpm -r run build` passes (drone-core FIRST, then drone-agent resolves roundComplete/DroneWakelockConfig from dist/).
- `pnpm lint` passes (eslint + prettier).
- `pnpm test` fast suite passes, including new wakelock-plugin.test.ts.
- `pnpm typecheck` passes.
- Verify roundComplete reaches onConversationEvent (plugin test asserting both acquire+release fire for a synthetic userMessage→roundComplete sequence).
- Confirm no TUI regression: app.tsx/output-handlers.ts still compile with roundComplete in union (non-exhaustive switches ignore it).
- No dead code, no fluff comments, unused imports/vars removed.

## Step 5 (try/finally wrap) — EXECUTOR NOTE
Do NOT manually re-indent the ~620-line sendUserMessage body. Just add the `try { ... } finally { ... }` brackets around the existing body and run `pnpm lint` (prettier) to normalize indentation. This is the project convention (AGENTS.md: prettier handles formatting; don't hand-match it). Re-read the file after prettier before further edits.
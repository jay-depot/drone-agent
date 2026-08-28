---
key: wakelock-plugin-plan
tags:
  []
created: 2026-08-28T14:58:37.137Z
updated: 2026-08-28T15:20:36.318Z
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
8. `drone-agent/test/wakelock-plugin.test.ts` (new) — unit tests (11 tests).
9. `docs/agents/debug-flag.md` — add `wakelock` row to "Current Subsystems" table.
10. `AGENTS.md` — add wakelock to config-section list + note roundComplete silent-signal deviation (done).

## Plugin implementation (implemented)
The plugin lives at `drone-agent/src/plugins/wakelock/index.ts`:
- metadata: `{ id: 'wakelock', name: 'Wakelock', version: '0.1.0', defaultEnabled: false }`
- register(): guards — subagent (no-op), config.enabled false (no-op), WSL (log warning, no-op), unsupported platform (no-op).
- resolveInhibitor(): darwin→caffeinate -i; linux→systemd-inhibit --what=idle:sleep sleep infinity; else null.
- boolean state machine: acquire() spawns inhibitor idempotently (guards on ENOENT, attaches 'error' handler); release() kills it.
- onConversationEvent: userMessage→acquire, roundComplete→release. onShutdown: kill live child. registerHelp added.
- debug gate: `runtime.flags.isEnabled('wakelock')` controls info/warn logging (--debug wakelock subsystem).

## Tests (implemented, 11 passing)
mock registration + mocked child_process spawn + mocked /proc/version. Covers: defaultEnabled=false; subagent no-op; disabled no-op; idempotent acquire on repeated userMessage; release on roundComplete; roundComplete-without-userMessage no-op; unavailable-command no-throw; WSL warning+no-op; shutdown kill; debug logging on/off; macOS caffeinate command.

## Validation criteria — ALL PASS
- `pnpm -r run build` ✓ (drone-core first, clean)
- `pnpm typecheck` ✓ (incl. test tsconfig)
- `pnpm lint` ✓ (eslint + prettier)
- `pnpm test` fast suite ✓ (2321 passed, 9 skipped / 160 files)
- LSP clean on all touched files ✓
- wakelock-plugin.test.ts: 11/11 ✓

## Step 5 (try/finally wrap) — EXECUTOR NOTE
Do NOT manually re-indent the ~620-line sendUserMessage body. Just add the `try { ... } finally { ... }` brackets around the existing body and run `pnpm lint` (prettier) to normalize indentation. This is the project convention (AGENTS.md: prettier handles formatting; don't hand-match it). Re-read the file after prettier before further edits.

## Execution notes / gotchas hit
- **file__apply_diff corrupts large files**: on `config-types.ts` and `conversation-service.ts`, apply_diff reported "patched: true" but silently dropped/duplicated edits at the file tail (duplicate trailing brace, missing merge-spec line) — a known issue documented in `.drone-agent/insights/project/project.json`. Mitigation: apply edits to large files via a deterministic Node `readFileSync`/`writeFileSync` script instead of apply_diff, then verify with grep + build. This worked reliably for config-types, conversation-service, and the 3 test-file mock-config updates.
- **Adding a required field to DroneAgentConfig breaks test mock config literals**: three test files (log-plugin, prompt-file, terminal.test) construct `DroneAgentConfig` literals and needed `wakelock: { enabled: false }` added. Always sweep test mocks when adding a required config field.
- **try/finally wrap of sendUserMessage**: the method contains a `while(true)` loop; inserting `try {` after the func-open and `} finally {...}` between the while-close and method-close requires care. Verify brace balance programmatically (count `{`/`}` over the method body) after editing.
- **git stash/pop lost edits**: after a `git stash` + `git stash pop` for a clean-build comparison, three of the applied edits to config-types.ts were missing (not re-applied). Re-verify all edits after any stash cycle.
- Prettier re-wraps long lines when re-indenting (conversation-service grew whitespace diff but logic preserved). Use `git diff -w` to confirm only whitespace + the intended additions.

---
key: plan-debug-tools-flag
tags:
  []
created: 2026-08-10T03:55:46.676Z
updated: 2026-08-10T04:08:27.715Z
---

# Plan: `--debug tools` Flag + Shared DebugFlagRegistry Refactor

## Status: COMPLETED (2026-08-10)

## Summary

Added a `--debug tools` subsystem that logs to stderr whenever a tool's surface changes: mount, unmount, register, unregister, plugin enable, add-external-plugin. Modeled on the existing `--debug llm` flag.

**Required refactor:** The debug set previously lived privately inside the conversation service (`debugSet`). The engine — where all tool-surface mutations happen — is created *before* the conversation service in `index.tsx`, so it could not read that set. We extracted a shared `DebugFlagRegistry` in `drone-core` (mirroring the existing `RuntimeFlagRegistry` pattern), created once in `index.tsx` and passed to both the engine and the conversation service. This also makes future debug flags easy to add and keeps `--debug tools` runtime-toggleable via `/debug enable tools`.

**Decision (clean break):** The conversation service's `debugSubsystems?: string[]` constructor param was DROPPED. Verified: no test or other call site passed it (only `cli.ts` produces it as CLI input, and `index.tsx` wires it). The registry is seeded once in `index.tsx` from `invocation.options.debugSubsystems` and becomes the single source of truth. This makes sync issues structurally impossible (no dual source of truth) with zero test churn.

## Design

- **`DebugFlagRegistry`** (drone-core): `isEnabled(name)`, `enable(name)`, `disable(name)`, `list()`. Backed by a `Set<string>`.
- **`index.tsx`**: create the registry from `invocation.options.debugSubsystems`; pass to both `createDronePluginEngine` and `createConversationService`.
- **conversation-service.ts**: remove `debugSubsystems` param; take `debugFlags: DebugFlagRegistry`. Its existing `getDebugSubsystems`/`enableDebugSubsystem`/`disableDebugSubsystem` methods delegate to the registry, so the `/debug` command + TUI wiring stay unchanged. `debug: debugFlags.isEnabled('llm')` replaces `debugSet.has('llm')`.
- **plugin-engine.ts**: accept `debugFlags` in `CreateDronePluginEngineOptions`. Log `[tools:...]` to stderr at each tool-surface mutation point when `debugFlags.isEnabled('tools')`.
- **Log format** (stderr, grep-able, mirrors `[llm:request]`): `[tools:mount] file__read`, `[tools:unmount] file__read`, `[tools:register] file__read`, `[tools:unregister] file__read`, `[tools:unregister-plugin] file`, `[tools:enable-plugin] file`, `[tools:add-external-plugin] file`.

## Files Modified

### 1. `drone-core/src/debug-flags.ts` (NEW)
`DebugFlagRegistry` type + `createDebugFlagRegistry(initial?: string[])` factory. Exported from `drone-core/src/index.ts`.

### 2. `drone-agent/src/runtime/plugin-engine.ts`
- Added `debugFlags?: DebugFlagRegistry` to `CreateDronePluginEngineOptions`; defaults to a no-op registry if absent.
- Added local `logToolChange(kind, detail)` helper that writes `[tools:${kind}] ${detail}` to stderr when `debugFlags.isEnabled('tools')`.
- Call sites: `registerTool` → `[tools:register]`, `mountTool` (registration + runtime meta-tool) → `[tools:mount]`, `unmountTool` (registration + runtime meta-tool) → `[tools:unmount]`, `unregisterToolImpl` → `[tools:unregister]`, `unregisterPluginToolsImpl` → `[tools:unregister-plugin]`, `doEnablePlugin` → `[tools:enable-plugin]`, `doAddExternalPlugin` → `[tools:add-external-plugin]`. Also logs register+mount for the 3 runtime meta-tools during `initialize()`.

### 3. `drone-agent/src/runtime/conversation-service.ts`
- Removed `debugSubsystems?: string[]` param and `const debugSet = new Set(debugSubsystems ?? [])`.
- Added `debugFlags?: DebugFlagRegistry` (defaults to no-op registry).
- `debug: debugFlags.isEnabled('llm')` in `provider.chat()`.
- `getDebugSubsystems`/`enableDebugSubsystem`/`disableDebugSubsystem` delegate to the registry.

### 4. `drone-agent/src/index.tsx`
- Created `const debugFlags = createDebugFlagRegistry(invocation.options.debugSubsystems)`.
- Passed `debugFlags` to both `createDronePluginEngine` and `createConversationService` (removed old `debugSubsystems` wiring).

### 5. `docs/agents/debug-flag.md`
- Added `tools` row to Current Subsystems table + updated "How It Works" to describe the shared registry.

## Tests Added

- **drone-core/test/debug-flags.test.ts** (6 tests): enable/disable/isEnabled/list, idempotent enable, initial seeding, disable no-op.
- **drone-agent/test/plugin-engine.test.ts** (3 tests): logs mount/unmount/register/unregister when enabled; logs nothing when disabled; logs enable-plugin/add-external-plugin.
- **drone-agent/test/conversation-service.test.ts** (1 test): passes `debug: true` to `provider.chat()` when `llm` enabled in shared registry.
- **drone-agent/test/builtin-commands.test.ts** (1 test): `/debug enable tools` / `/debug disable tools` mutate the shared registry.

## Validation Results

1. **LSP/typecheck**: No type errors in any modified file. (Pre-existing `useSgrMouse.test.tsx` errors remain — untouched, out of scope.)
2. **`pnpm -r run build`**: PASSES.
3. **`pnpm lint`**: PASSES.
4. **`pnpm test`**: PASSES (1765 passed, 9 skipped; 35 new tests).
5. **Manual**: `--debug tools` logs `[tools:mount]`/`[tools:unmount]` when the LLM mounts/unmounts tools; `/debug enable tools` toggles it at runtime; `--debug llm` still works unchanged.

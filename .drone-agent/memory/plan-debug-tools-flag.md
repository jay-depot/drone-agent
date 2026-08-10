---
key: plan-debug-tools-flag
tags:
  []
created: 2026-08-10T03:55:46.676Z
updated: 2026-08-10T03:58:15.970Z
---

# Plan: `--debug tools` Flag + Shared DebugFlagRegistry Refactor

## Summary

Add a `--debug tools` subsystem that logs to stderr whenever a tool's surface changes: mount, unmount, register, unregister, plugin enable, add-external-plugin. Modeled on the existing `--debug llm` flag.

**Required refactor:** The debug set currently lives privately inside the conversation service (`debugSet`). The engine — where all tool-surface mutations happen — is created *before* the conversation service in `index.tsx`, so it cannot read that set. We extract a shared `DebugFlagRegistry` in `drone-core` (mirroring the existing `RuntimeFlagRegistry` pattern), created once in `index.tsx` and passed to both the engine and the conversation service. This also makes future debug flags easy to add and keeps `--debug tools` runtime-toggleable via `/debug enable tools`.

**Decision (clean break):** The conversation service's `debugSubsystems?: string[]` constructor param is DROPPED. Verified: no test or other call site passes it (only `cli.ts` produces it as CLI input, and `index.tsx` wires it). The registry is seeded once in `index.tsx` from `invocation.options.debugSubsystems` and becomes the single source of truth. This makes sync issues structurally impossible (no dual source of truth) with zero test churn.

## Design

- **`DebugFlagRegistry`** (drone-core): `isEnabled(name)`, `enable(name)`, `disable(name)`, `list()`. Backed by a `Set<string>`.
- **`index.tsx`**: create the registry from `invocation.options.debugSubsystems`; pass to both `createDronePluginEngine` and `createConversationService`.
- **conversation-service.ts**: remove `debugSubsystems` param; take `debugFlags: DebugFlagRegistry`. Its existing `getDebugSubsystems`/`enableDebugSubsystem`/`disableDebugSubsystem` methods delegate to the registry, so the `/debug` command + TUI wiring stay unchanged. `debug: debugFlags.isEnabled('llm')` replaces `debugSet.has('llm')`.
- **plugin-engine.ts**: accept `debugFlags` in `CreateDronePluginEngineOptions`. Log `[tools:...]` to stderr at each tool-surface mutation point when `debugFlags.isEnabled('tools')`.
- **Log format** (stderr, grep-able, mirrors `[llm:request]`): `[tools:mount] file__read`, `[tools:unmount] file__read`, `[tools:register] file__read`, `[tools:unregister] file__read`, `[tools:unregister-plugin] file`, `[tools:enable-plugin] file`, `[tools:add-external-plugin] file`.

## Files to Modify

### 1. `drone-core/src/runtime-flags.ts` (or new `debug-flags.ts`)
Add `DebugFlagRegistry` type + `createDebugFlagRegistry(initial?: string[])` factory. Export from `drone-core/src/index.ts`.

### 2. `drone-agent/src/runtime/plugin-engine.ts`
- Add `debugFlags?: DebugFlagRegistry` to `CreateDronePluginEngineOptions`; default to a no-op registry if absent (so existing tests that don't pass it keep working).
- Add a local `logToolChange(kind, detail)` helper that writes `[tools:${kind}] ${detail}` to stderr when `debugFlags.isEnabled('tools')`.
- Call it at:
  - `registerTool` (in `registerPlugin`) → `[tools:register] <canonical>`
  - `mountTool` (registration + runtime meta-tool `runtime__mount_tool`) → `[tools:mount] <canonical>`
  - `unmountTool` (registration + `runtime__unmount_tool`) → `[tools:unmount] <canonical>`
  - `unregisterToolImpl` → `[tools:unregister] <canonical>`
  - `unregisterPluginToolsImpl` → `[tools:unregister-plugin] <pluginId>`
  - `doEnablePlugin` → `[tools:enable-plugin] <pluginId>`
  - `doAddExternalPlugin` → `[tools:add-external-plugin] <pluginId>`
- Note: `registerRuntimeMetaTools()` registers+mounts the 3 runtime meta-tools during `initialize()`; recommend logging these too (they're real surface changes, though they'll always appear at startup).

### 3. `drone-agent/src/runtime/conversation-service.ts`
- Add `debugFlags?: DebugFlagRegistry` to `CreateConversationServiceOptions`; default to a no-op registry if absent.
- REMOVE `debugSubsystems?: string[]` param and `const debugSet = new Set(debugSubsystems ?? [])`.
- `debug: debugFlags.isEnabled('llm')` in the `provider.chat()` call.
- `getDebugSubsystems`/`enableDebugSubsystem`/`disableDebugSubsystem` delegate to the registry.

### 4. `drone-agent/src/index.tsx`
- Create `const debugFlags = createDebugFlagRegistry(invocation.options.debugSubsystems)`.
- Pass `debugFlags` to both `createDronePluginEngine` and `createConversationService` (remove the old `debugSubsystems` wiring).

### 5. `docs/agents/debug-flag.md`
- Add `tools` row to the Current Subsystems table + a short "How It Works" note.

## Tests

- **drone-core/test/**: new `debug-flags.test.ts` for `createDebugFlagRegistry` (enable/disable/isEnabled/list, idempotent enable, initial seeding).
- **drone-agent/test/plugin-engine.test.ts**: new describe block — with `debugFlags` enabled, capture stderr (spy on `console.error`) and assert `[tools:mount]`/`[tools:unmount]`/`[tools:register]`/`[tools:unregister]` lines appear on mount/unmount/register/unregister; assert no output when disabled.
- **drone-agent/test/conversation-service.test.ts**: assert `debug: true` is passed to `provider.chat()` when `'llm'` is enabled in the shared registry (mirror existing behavior). Update any construction sites that relied on `debugSubsystems` (none currently do).
- **drone-agent/test/builtin-commands.test.ts**: `/debug enable tools` / `/debug disable tools` mutate the shared registry (via conversation adapter).

## Validation Criteria

1. **LSP passes** — no type errors in any modified file.
2. **`pnpm -r run build` passes** — all packages compile.
3. **`pnpm -r run lint` passes** — eslint + prettier.
4. **`pnpm -r run test` passes** — all existing + new tests.
5. **Manual:** `--debug tools` logs `[tools:mount]`/`[tools:unmount]` when the LLM mounts/unmounts tools; `/debug enable tools` toggles it at runtime; `--debug llm` still works unchanged.

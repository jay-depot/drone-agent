---
tags: [decision, cli, debugging, tools, list-mount]
related: [decisions/082-debug-flag-llm-logging.md, decisions/097-debug-slash-command.md, modules/drone-core.md, modules/drone-agent.md]
---

# ADR 110: `--debug tools` Flag + Shared `DebugFlagRegistry` Refactor

**Status**: Implemented (commit `7547bfe`, 2026-08-10)

## Context

The `--debug llm` flag ([082-debug-flag-llm-logging](082-debug-flag-llm-logging.md)) logged LLM request/response bodies, but there was no way to trace the **tool surface** — when tools are mounted, unmounted, registered, unregistered, or when plugins are enabled. Debugging tool-surface issues (e.g. why a tool disappeared, why a mount failed) required adding temporary `console.log` statements.

A deeper structural problem: the debug subsystem set (`debugSet`) lived **privately inside the conversation service**. The plugin engine — where all tool-surface mutations happen — is created *before* the conversation service in `index.tsx`, so it could not read that set. There was no shared, single source of truth for which debug subsystems are active.

## Decision

Add a `--debug tools` subsystem that logs tool surface changes to stderr, modeled on `--debug llm`. This required extracting a shared `DebugFlagRegistry` in `drone-core` (mirroring the existing `RuntimeFlagRegistry` pattern), created once in `index.tsx` and passed to both the plugin engine and the conversation service.

### `DebugFlagRegistry` (drone-core)

```typescript
export type DebugFlagRegistry = {
  isEnabled(name: string): boolean;
  enable(name: string): void;
  disable(name: string): void;
  list(): string[];
};

export function createDebugFlagRegistry(initial?: string[]): DebugFlagRegistry;
```

Backed by a `Set<string>`, created once from `invocation.options.debugSubsystems` in `index.tsx` and passed to both `createDronePluginEngine` and `createConversationService`.

### Clean break: conversation service `debugSubsystems` param dropped

The conversation service's `debugSubsystems?: string[]` constructor param was **removed**. Verified no test or other call site passed it — only `cli.ts` produces it as CLI input and `index.tsx` wires it. The registry is seeded once and becomes the single source of truth, making sync issues structurally impossible (no dual source of truth) with zero test churn.

The conversation service's existing `getDebugSubsystems`/`enableDebugSubsystem`/`disableDebugSubsystem` methods now **delegate to the registry**, so the `/debug` command ([097-debug-slash-command](097-debug-slash-command.md)) and TUI wiring stay unchanged. `debug: debugFlags.isEnabled('llm')` replaces `debugSet.has('llm')`.

### Engine logging

`plugin-engine.ts` accepts `debugFlags?` in `CreateDronePluginEngineOptions` (defaults to a no-op registry). A local `logToolChange(kind, detail)` helper writes `[tools:${kind}] ${detail}` to stderr when `debugFlags.isEnabled('tools')`. Call sites cover every tool-surface mutation point:

- `registerTool` → `[tools:register]`
- `mountTool` (registration + runtime meta-tool) → `[tools:mount]`
- `unmountTool` (registration + runtime meta-tool) → `[tools:unmount]`
- `unregisterToolImpl` → `[tools:unregister]`
- `unregisterPluginToolsImpl` → `[tools:unregister-plugin]`
- `doEnablePlugin` → `[tools:enable-plugin]`
- `doAddExternalPlugin` → `[tools:add-external-plugin]`
- The 3 runtime meta-tools during `initialize()` also log register + mount

### Docs

`docs/agents/debug-flag.md` documents the `tools` subsystem and the shared registry, listing all `[tools:...]` prefixes.

## Consequences

### Positive

- Tool-surface changes are traceable via `--debug tools` to stderr (`[tools:mount] file__read`, etc.), grep-able and consistent with `[llm:request]`/`[llm:response]`
- The shared `DebugFlagRegistry` is the single source of truth for enabled subsystems — toggling via `/debug enable|disable` takes effect immediately in both the engine and the conversation service
- Future debug subsystems are trivial to add (just check `debugFlags.isEnabled('name')`)
- No dual source of truth / no sync bugs possible

### Neutral

- The conversation service now depends on the shared registry rather than its own local set

## Tests

- `drone-core/test/debug-flags.test.ts` (new) — 6 tests: enable/disable/isEnabled/list, idempotent enable, initial seeding, disable no-op
- `drone-agent/test/plugin-engine.test.ts` — 3 tests: logs mount/unmount/register/unregister when enabled, logs nothing when disabled, logs enable-plugin/add-external-plugin
- `drone-agent/test/conversation-service.test.ts` — 1 test: passes `debug: true` to `provider.chat()` when `llm` enabled in shared registry
- `drone-agent/test/builtin-commands.test.ts` — 1 test: `/debug enable tools` / `/debug disable tools` mutate the shared registry

## Related

- [082-debug-flag-llm-logging](082-debug-flag-llm-logging.md) — The original `--debug llm` flag this extends
- [097-debug-slash-command](097-debug-slash-command.md) — The `/debug` command that mutates the shared registry at runtime
- [drone-core](../../drone-core/) — `DebugFlagRegistry` and `createDebugFlagRegistry`
- [drone-agent](../../drone-agent/) — Wiring in `index.tsx`, engine + conversation service

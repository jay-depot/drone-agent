---
tags: [decision, systemprompt, runtime-flags, slash-command]
related:
  [
    decisions/100-list-mount-improvements.md,
    modules/drone-agent.md,
    modules/drone-core.md,
    architecture/plugin-system.md,
  ]
---

# Decision 101: `/systemprompt` Shows Runtime Flags

**Summary**: The `/systemprompt` slash command was manually assembling its output from `config.systemPrompt` + `renderPromptFragments()`, bypassing the context budget service's `buildSystemMessages()`. This meant the runtime flags block (list-mount explainer, active plugins) was sent to the LLM but invisible to the user. Fixed by adding `buildSystemMessages` to the engine interface and having the handler use it.

## Context

The runtime flags system ([100-list-mount-improvements](100-list-mount-improvements.md)) injects a `# Runtime Flags` block into the system prompt via `context-budget-service.ts`'s `buildSystemMessages()`. This block includes:

- A `## List/Mount Pattern` explainer teaching the LLM how to use `__list_tools`/`__mount_tool`/`__unmount_tool`
- `Active list-mount plugins: file, lsp, git, mcp, swarm`

However, the `/systemprompt` slash command in `builtin-commands.ts` was written before the runtime flags system existed. It manually assembled its output from `config.systemPrompt` + `renderPromptFragments()`, completely bypassing `buildSystemMessages()`. The runtime flags block was invisible to the user.

## Decision

Add `buildSystemMessages` to the engine interface, wire it from the budget service, and have the `/systemprompt` handler use it.

### Architecture

1. **`DronePluginEngine` interface** — Added `buildSystemMessages: () => Promise<DroneChatMessage[]>` method
2. **`CreateDronePluginEngineOptions`** — Added optional `buildSystemMessages` parameter for the host to inject
3. **Engine fallback** — When no host-provided function is given, the engine falls back to the old manual assembly (`config.systemPrompt` + rendered prompt fragments), preserving backward compatibility
4. **`index.tsx` wiring** — Passes `() => budgetService.buildSystemMessages()` to `createDronePluginEngine`
5. **`DroneSlashCommandContext.engine`** — Added `buildSystemMessages` to the engine sub-type so slash command handlers can call it
6. **`DroneTuiOptions.engine`** — Added `buildSystemMessages` to the `Pick` type for TUI test mocks
7. **`/systemprompt` handler** — Replaced manual assembly with `ctx.engine.buildSystemMessages()`

### Key Files

- `drone-agent/src/runtime/plugin-engine.ts` — Interface + options + fallback
- `drone-agent/src/index.tsx` — Wiring
- `drone-agent/src/runtime/builtin-commands.ts` — Handler update
- `drone-core/src/plugin-system.ts` — Slash command context type
- `drone-agent/src/tui/types.ts` — TUI options type
- `drone-agent/test/systemprompt.test.tsx` — Test mocks updated

## Consequences

### Positive

- **User sees what the LLM sees** — `/systemprompt` now shows the exact system messages sent to the LLM, including runtime flags
- **No duplication** — The handler delegates to the same `buildSystemMessages()` that the conversation service uses, so there's only one source of truth for system message assembly
- **Backward compatible** — The engine fallback produces the same output as the old manual assembly when no host-provided function is given

### Negative

- **Engine interface growth** — Every new method on `DronePluginEngine` requires updating the `DroneTuiOptions.engine` `Pick` type and any test mocks that construct partial engines

## Implementation

- **Branch**: `feat/lsp-file-list-mount-conversion`
- **Commit**: `693e44d`
- **Files changed**: 6 source files + 1 test file
- **Validation**: 108 test files, 1694 tests passed. Lint, build, LSP diagnostics all clean.

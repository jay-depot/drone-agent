---
tags: [decision, code-quality, refactoring]
related: [decisions/048-large-file-splitting.md, modules/drone-core.md, modules/drone-agent-plugins.md, modules/drone-agent.md, modules/drone-agent-tui.md]
---

# ADR 087: Code Quality Cleanup

**Status**: Implemented (commits `cffbd99`, `df439c5`, `4966319`)

## Problem

A comprehensive codebase review identified 22 code quality issues across the drone-agent monorepo, spanning logic bugs, dead code, duplication, and style/readability problems.

## Solution

### Step 1: Fix Logic Bugs

- **Stale tool list in `sendUserMessage` loop**: Moved `const tools = getLlmTools()` from outside the `while(true)` loop to inside the loop body, right after the cancel check and before `ensureSafeBudget()`. This ensures dynamic tool changes (MCP mount/unmount, persona switches) are reflected in subsequent iterations.
- **`toolCall` handler uses wrong field**: In `output-handlers.ts`, changed `event.content` to `event.arguments` for the `toolCall` case. The `DroneConversationEvent` discriminated union has `toolCall` with `name` and `arguments` fields, not `content`.

### Step 2: Remove Dead Code

- **`diff-renderer.ts`**: Removed `supportsColor()`, `stripAnsi()`, `renderDiff()`, `renderHunk()`, `DiffHunk` interface. Kept `renderDiffV2()`, `renderHunkV2()`, `DiffHunkV2`, `DiffResult`, `DiffSummary`, `FuzzLevel`, `countChanges()`.
- **`type-guards.ts`**: Removed `isStringArray()` function.
- **`output-handlers.ts`**: Removed `makeJsonOutputEventHandler()` and `writeNdjsonEvent()` functions. Kept `makePlainOutputEventHandler()`, `makeNdjsonOutputEventHandler()`, `OutputEvent` type.
- **`session-types.ts`**: Removed `DroneSessionState` type and its export from `drone-core/src/index.ts`.
- **`config-types.ts`**: Removed `DroneSessionPhase` type and its export from `drone-core/src/index.ts`.
- **`plugin-system.ts`**: Removed `DroneMacroStep` and `DroneMacroDefinition` types and their exports from `drone-core/src/index.ts`. These types are now defined in the macros plugin's own `types.ts`.

### Step 3: Consolidate Duplicated Code

- **`sorted-registry.ts`**: Extracted `insertSortedByPrecedence`, `removeById`, and `insertWriterSorted` from the skills and persona broker plugins into a shared utility at `drone-core/src/sorted-registry.ts`. Both plugins now import and use these shared functions.
- **`createLlmGetters()`**: Extracted a helper function in `index.tsx` that creates `getProvider` and `getModel` closures. Replaced the duplicated inline closures in both `createContextBudgetService` and `createBuiltInPlugins` calls.

### Step 4: Style and Readability Cleanup

- **`hasOwnProperty` → `in` operator**: In `plugin-engine.ts`, replaced `Object.prototype.hasOwnProperty.call(raw, 'kickMessage')` with `'kickMessage' in raw`.
- **String concatenation → template literals**: In skills and persona plugins, replaced all `'string ' + var + ' more'` patterns with template literals.
- **Env var regex**: In `config-schema.ts`, changed regex from `/\\$\\{([A-Z0-9_]+)\\}/g` to `/\\$\\{([A-Za-z0-9_]+)\\}/g` to support lowercase env var names.
- **TUI ref-based callbacks**: In `app.tsx`, refactored the conversation event listener `useEffect` to store callbacks in refs (`logRef`, `appendEntryRef`, etc.) so the effect only depends on `opts.engine` instead of many closure values.
- **Merged `useInput` hooks**: Combined the global keybindings `useInput` and the elicitation `useInput` into a single `useInput` with a unified dispatch that checks `activeQuestion` first, then falls through to global bindings.
- **Redundant `buildSystemMessages()` call**: In compaction's `runCompaction`, removed the call to `budgetService.buildSystemMessages()`. The function receives `systemPrompt` as a parameter — use it directly.
- **Extracted `createDefaultCliOptions()`**: In `cli.ts`, extracted the repeated `options: CliOptions = { ... }` initialization into a helper function.
- **Simplified ID generation**: In `useTailRegion.ts` and `useChatLog.ts`, removed the `Date.now()` prefix from generated IDs.

## Files Changed

- `drone-agent/src/runtime/conversation-service.ts` — Moved `getLlmTools()` inside loop
- `drone-agent/src/output-handlers.ts` — Fixed `toolCall` handler, removed dead code
- `drone-agent/src/shared/diff-renderer.ts` — Removed dead functions
- `drone-agent/src/shared/type-guards.ts` — Removed `isStringArray()`
- `drone-agent/src/runtime/plugin-engine.ts` — `hasOwnProperty` → `in`
- `drone-agent/src/plugins/compaction/index.ts` — Removed redundant `buildSystemMessages()`
- `drone-agent/src/plugins/skills/index.ts` — Template literals, use sorted-registry
- `drone-agent/src/plugins/persona/index.ts` — Template literals, use sorted-registry
- `drone-agent/src/tui/app.tsx` — Ref-based callbacks, merged useInput
- `drone-agent/src/tui/hooks/useTailRegion.ts` — Simplified ID generation
- `drone-agent/src/tui/hooks/useChatLog.ts` — Simplified ID generation
- `drone-agent/src/cli.ts` — Extracted `createDefaultCliOptions()`
- `drone-agent/src/index.tsx` — Extracted `createLlmGetters()`
- `drone-core/src/sorted-registry.ts` — New file with shared sorted-registry utilities
- `drone-core/src/config-types.ts` — Removed `DroneSessionPhase`
- `drone-core/src/session-types.ts` — Removed `DroneSessionState`
- `drone-core/src/plugin-system.ts` — Removed `DroneMacroStep`, `DroneMacroDefinition`
- `drone-core/src/index.ts` — Updated exports
- `drone-core/src/config-schema.ts` — Fixed env var regex

## Validation

- LSP clean
- `pnpm -r run build` passes
- `pnpm -r run lint` passes
- `pnpm -r run test` passes (104 files, 1632 tests)
- No remaining references to removed exports/types

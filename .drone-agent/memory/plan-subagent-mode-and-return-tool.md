---
key: plan-subagent-mode-and-return-tool
tags:
  - plan
  - subagent
  - bugfix
  - review-state
  - completed
created: 2026-08-11T05:00:11.372Z
updated: 2026-08-11T05:14:47.003Z
---

# Plan: Fix Subagent Mode Activation + Return Tool (review-state items #1 + #2)

## Summary

The subagent system has six intertwined bugs that make explicit subagent return fundamentally broken:

1. **Bug #1 (registration ordering)**: The `_runtime` capability (carrying `isSubagent`) is set AFTER the plugin registration loop, but the subagent plugin requests it synchronously during `register()`. Result: the subagent always registers in main-agent mode — the return tool is never registered in subagent mode.

2. **Bug #2a (canonical name mismatch)**: `hasExplicitReturn` in `interactive.ts` checks `event.name === 'subagent.return'`, but the conversation service emits canonical names (`subagent__subagent.return`). The check never matches.

3. **Bug #2b (dot in tool name)**: `subagent.return` contains a dot, which breaks some Kimi models.

4. **Bug #2c (pokemon naming)**: Registering `name: 'subagent.return'` inside the `subagent` plugin produces the doubled prefix `subagent__subagent.return`.

5. **Bug #2d (toolCallBatch vs toolCall)**: The `hasExplicitReturn` check looks at `event.kind === 'toolCall'`, but the conversation service emits `toolCallBatch` events (not individual `toolCall` events).

6. **Bug #2e (process.exit makes hasExplicitReturn moot)**: Even if all the above were fixed, the return tool calls `process.exit(0)` inside `execute`, killing the process before the conversation loop returns to the `hasExplicitReturn` check.

The fix involves: (A) moving `_runtime` before the registration loop, (B) renaming the tool to `'return'` (canonical `subagent__return`), and (C) replacing `process.exit(0)` with a proper stop-signal mechanism so the conversation loop can exit gracefully and `hasExplicitReturn` actually functions.

## Step-by-Step Plan

### Step 1: Add `DroneToolExecutionContext` type to drone-core

**File:** `drone-core/src/plugin-system.ts`
**Agent:** coder

Add a new type that extends the tool execution context with a stop signal:

```ts
export type DroneToolExecutionContext = {
  /** Signal the conversation loop to stop after processing the current tool batch. */
  stopLoop?: () => void;
};
```

Update `DroneToolDefinition.execute` signature to accept an optional context:

```ts
export type DroneToolDefinition = {
  name: string;
  description: string;
  inputSchema?: DroneToolJsonSchema;
  defaultHidden?: boolean;
  renderComponent?: (state: ToolRenderState) => unknown;
  execute: (
    input: Record<string, unknown>,
    onProgress?: (chunk: string) => void,
    context?: DroneToolExecutionContext
  ) => Promise<string>;
};
```

Export `DroneToolExecutionContext` from `drone-core/src/index.ts`.

### Step 2: Thread the stop signal through the engine's `executeTool`

**File:** `drone-agent/src/runtime/plugin-engine.ts`
**Agent:** coder

Update the `DronePluginEngine['executeTool']` type and the implementation to accept and pass through an optional context:

```ts
executeTool: (
  canonicalName: string,
  input: Record<string, unknown>,
  onProgress?: (chunk: string) => void,
  context?: DroneToolExecutionContext
) => Promise<string>;
```

Implementation (line ~848):
```ts
executeTool: async (canonicalName, input, onProgress, context) => {
  const tool = toolRegistry.get(canonicalName);
  if (!tool) throw new Error(`Unknown tool: ${canonicalName}`);
  return tool.execute(input, onProgress, context);
},
```

Also update the `DroneSlashCommandContext.engine.executeTool` type in `drone-core/src/plugin-system.ts` to accept the optional context (though slash command callers won't use it).

### Step 3: Thread the stop signal through the conversation service

**File:** `drone-agent/src/runtime/conversation-service.ts`
**Agent:** coder

In the `sendUserMessage` loop, add a `shouldStopLoop` flag. When executing tool calls, pass a context with a `stopLoop` callback:

```ts
let shouldStopLoop = false;

// In the tool execution block:
const rawResults = await Promise.all(
  toolCalls.map(toolCall =>
    executeToolSafely(
      toolCall.name,
      toolCall.arguments,
      (chunk: string) => { emit({ kind: 'toolProgress', name: toolCall.name, content: chunk }); },
      { stopLoop: () => { shouldStopLoop = true; } }  // NEW
    )
  ).then(...)
);
```

Update `executeToolSafely` to accept and pass the context:

```ts
async function executeToolSafely(
  canonicalName: string,
  input: Record<string, unknown>,
  onProgress?: (chunk: string) => void,
  context?: DroneToolExecutionContext
): Promise<...> {
  try {
    const content = await engine.executeTool(canonicalName, input, onProgress, context);
    return { kind: 'ok', content };
  } catch (err) { ... }
}
```

After the tool results are appended and hooks run, check the flag:

```ts
if (shouldStopLoop) {
  // Return the last assistant message (or empty string) instead of continuing the loop
  const lastAssistantMessage = response.message ?? '';
  return lastAssistantMessage;
}
```

This goes right before the `continue;` at the end of the tool-call block (line ~598).

### Step 4: Move `_runtime` capability before plugin registration loop

**File:** `drone-agent/src/runtime/plugin-engine.ts` (`initialize()`, line ~764)
**Agent:** coder

Move the `capabilities.set('_runtime', ...)` block to BEFORE the `for (const plugin of sortedPlugins)` registration loop:

```ts
return {
  initialize: async () => {
    for (const cmd of BUILT_IN_SLASH_COMMANDS) {
      builtInSlashCommands.push(cmd);
    }

    // Set _runtime BEFORE plugin registration so plugins can request it during register()
    capabilities.set('_runtime', {
      subagentId: runtimeOptions?.subagentId,
      persona: runtimeOptions?.persona,
      isSubagent: !!runtimeOptions?.subagentId,
      flags: runtimeFlagRegistry,
    });

    logger.info(`initializing ${sortedPlugins.length} plugin(s)`);
    for (const plugin of sortedPlugins) {
      registeredPlugins.push(await registerPlugin(plugin));
    }

    registerRuntimeMetaTools();

    // Inject enabled plugin list into system prompt
    const enabledPluginList = Array.from(enabledPluginIds).sort().join(', ');
    runtimeFlagRegistry.set('plugins', enabledPluginList);

    logOverrideWarnings();
    return registeredPlugins;
  },
  ...
```

### Step 5: Rename the return tool + update prompt fragment

**File:** `drone-agent/src/plugins/subagent/plugin.ts`
**Agent:** coder

Rename the tool from `'subagent.return'` to `'return'` (canonical becomes `subagent__return`):

```ts
ctx.registerTool({
  name: 'return',
  description: 'Return the result to the parent agent',
  inputSchema: { ... },  // unchanged
  execute: async (input, _onProgress, context) => {
    // Write the NDJSON return event, then signal the loop to stop
    const returnEvent: OutputEvent = {
      kind: 'return',
      subagentId: runtime.subagentId,
      result: input.result as string,
      error: input.error as string | undefined,
    };
    writeNdjsonEvent(returnEvent);
    context?.stopLoop?.();
    return JSON.stringify({ returned: true, result: input.result });
  },
});
```

Update the prompt fragment:

```ts
ctx.registerPromptFragment({
  key: 'subagent-return-instruction',
  phase: 'header',
  render: async () =>
    `# Subagent Instructions\n\nYou are a subagent. When you have completed your task, you MUST call the subagent__return tool with the result. Do NOT output the result as a message — use the tool to return it.`,
});
```

### Step 6: Fix `hasExplicitReturn` check in `interactive.ts`

**File:** `drone-agent/src/interactive.ts`
**Agent:** coder

Update the check to use the canonical name AND look inside `toolCallBatch` events:

```ts
const conversationHandler: ConversationEventHandler = (
  event: ConversationEvent
) => {
  // Track if an explicit return event was emitted
  if (event.kind === 'toolCallBatch') {
    for (const tc of event.toolCalls) {
      if (tc.name === 'subagent__return') {
        hasExplicitReturn = true;
      }
    }
  }
  // ... rest of switch unchanged
};
```

Also update the JSDoc comments on lines 80 and 198 to reference `subagent__return` instead of `subagent.return`.

### Step 7: Update all remaining references

**Agent:** coder

Sweep all files referencing `subagent.return` and update to `subagent__return`:

| File | Line(s) | Change |
|---|---|---|
| `drone-agent/src/output-handlers.ts` | 83 | JSDoc comment: `subagent.return` → `subagent__return` |
| `drone-agent/test/subagent/dispatch.test.ts` | 106, 118 | Test descriptions: `subagent.return` → `subagent__return` |
| `drone-agent/test/subagent/dispatch.test.ts` | 309 | Task string: `subagent.return` → `subagent__return` |
| `drone-agent/test/fixtures/subagent.ts` | 436 | Task string: `subagent.return` → `subagent__return` |
| `vitest.config.ts` | 48 | Skip comment: `subagent.return` → `subagent__return` |
| `vitest.integration.config.ts` | 23 | Skip comment: `subagent.return` → `subagent__return` |

### Step 8: Update test mocks for new `executeTool` signature

**Agent:** coder

Update mock engines to accept the new optional `context` parameter:

- `drone-agent/test/helpers.ts` line 199: `executeTool: async () => ''` → `executeTool: async () => ''` (signature already matches since context is optional, but verify)
- `drone-agent/test/helpers.ts` line 239-274: `MockEngineOptions.executeToolImpl` — verify it still works with the new optional param
- `drone-agent/test/llm-provider-switching.test.ts` line 138: verify
- `drone-agent/test/todo-sidebar.test.ts` lines 24, 53, 64, 85: verify

### Step 9: Add/update tests

**Agent:** coder

1. **Plugin engine test**: Verify `_runtime` capability is available during `register()` — add a test that registers a dummy plugin which requests `'runtime'` during registration and confirms it receives the correct `isSubagent` value.

2. **Subagent plugin test**: Verify the return tool is named `'return'` (canonical `subagent__return`) and is registered in subagent mode.

3. **Conversation service test**: Verify that when a tool calls `context.stopLoop()`, the conversation loop breaks and returns instead of continuing to the LLM.

4. **`hasExplicitReturn` test**: Verify that when the return tool is called (via `toolCallBatch` with name `subagent__return`), `hasExplicitReturn` is set to `true` and no implicit return event is emitted.

### Step 10: Build, lint, typecheck, and test

**Agent:** coder

1. `pnpm -r run build` — verify all packages compile (especially drone-core after type changes)
2. `pnpm -r run lint` — verify ESLint + Prettier pass
3. `pnpm -r run typecheck` — verify TypeScript types are correct
4. `pnpm -r run test` — verify all fast tests pass

### Step 11: Verify against validation criteria

**Agent:** reviewer

Check all validation criteria (below) are met.

## Validation Criteria

- [x] `pnpm -r run build` passes with zero errors
- [x] `pnpm -r run lint` passes with zero errors
- [x] `pnpm -r run typecheck` passes with zero errors
- [x] `pnpm -r run test` (fast suite) passes with zero errors
- [x] LSP diagnostics show no new errors
- [x] The `_runtime` capability is set BEFORE the plugin registration loop in `initialize()`
- [x] The return tool is registered with `name: 'return'` (no dot, no doubled prefix)
- [x] The canonical name `subagent__return` is used consistently in all references
- [x] `process.exit(0)` is removed from the return tool's `execute` — replaced with `context.stopLoop()`
- [x] The conversation service breaks the tool-call loop when `stopLoop()` is called
- [x] `hasExplicitReturn` checks `toolCallBatch` events (not `toolCall`) and compares against `'subagent__return'`
- [x] The prompt fragment text references `subagent__return` (not `subagent.return`)
- [x] All test mocks updated for the new `executeTool` signature
- [x] New tests cover: _runtime ordering, tool naming, stopLoop behavior, hasExplicitReturn

## Implementation Summary (2026-08-11)

All 11 steps completed and validated. Committed as `4f3e45b` on branch `fix/subagent-mode-and-return-tool`.

**What changed:**
- Added `DroneToolExecutionContext` type to drone-core (plugin-system.ts, index.ts)
- Threaded `context?: DroneToolExecutionContext` through `DronePluginEngine.executeTool`, `DroneSlashCommandContext.engine.executeTool`, and conversation service's `executeToolSafely`
- Added `shouldStopLoop` flag to conversation service's `sendUserMessage` loop; breaks the loop when any tool calls `context.stopLoop()`
- Moved `capabilities.set('_runtime', ...)` before the plugin registration loop in `initialize()`
- Renamed return tool `'subagent.return'` → `'return'` (canonical `subagent__return`); replaced `process.exit(0)` with `context?.stopLoop?.()`
- Fixed `hasExplicitReturn` in `interactive.ts` to check `toolCallBatch` events against `'subagent__return'`
- Updated all `subagent.return` references to `subagent__return` across 6 files
- Added tests: `_runtime` ordering, subagent plugin tool naming + stopLoop, conversation service stopLoop break, and toolCallBatch canonical name emission

**Files changed (17):**
- drone-core/src/plugin-system.ts, drone-core/src/index.ts
- drone-agent/src/runtime/plugin-engine.ts, drone-agent/src/runtime/conversation-service.ts
- drone-agent/src/plugins/subagent/plugin.ts, drone-agent/src/interactive.ts, drone-agent/src/output-handlers.ts
- drone-agent/test/subagent-plugin.test.ts (new), drone-agent/test/plugin-engine.test.ts, drone-agent/test/conversation-service.test.ts, drone-agent/test/helpers.ts, drone-agent/test/subagent/dispatch.test.ts, drone-agent/test/fixtures/subagent.ts
- vitest.config.ts, vitest.integration.config.ts
- .drone-agent/memory/review-state.md (prettier formatting only)
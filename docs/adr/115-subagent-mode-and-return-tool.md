---
tags: [decision]
related: [concepts/subagent.md, flows/tool-call-loop.md, entities/DronePlugin.md, decisions/071-tool-consolidation-batch-2.md, decisions/104-subagent-activity-timeout-and-error-detection.md]
---

# 115. Fix subagent mode activation + return tool (review-state #1 + #2)

**Summary**: Fixed six intertwined bugs that made explicit subagent return fundamentally broken — the subagent mode was never activated (`_runtime` capability set too late), the return tool had a dot/doubled-prefix name, `hasExplicitReturn` checked the wrong event kind/name, and `process.exit(0)` killed the process before the loop could return.

## Context

The subagent system's explicit return path was entirely non-functional. Subagents relied exclusively on the implicit-return fallback. Six distinct bugs compounded:

1. **`_runtime` set too late** — `capabilities.set('_runtime', ...)` ran AFTER the plugin registration loop in `initialize()`, but the subagent plugin requests it synchronously at the top of `register()`. So `runtime?.isSubagent` was always falsy and the return tool was never registered in subagent mode.

2. **Canonical name mismatch** — `hasExplicitReturn` in `interactive.ts` checked `event.name === 'subagent.return'`, but the conversation service emits canonical names (`subagent__subagent.return`). Never matched.

3. **Dot in tool name** — `subagent.return` contains a dot, which breaks some Kimi models.

4. **Doubled prefix ("pokemon" naming)** — registering `name: 'subagent.return'` inside the `subagent` plugin produced canonical `subagent__subagent.return`. Same regression as decision 071 fixed for `subagent__subagent__dispatch`.

5. **Wrong event kind** — `hasExplicitReturn` checked individual `toolCall` events, but the conversation service emits `toolCallBatch` (flattened for non-TUI consumers).

6. **`process.exit(0)`** — Even with all the above fixed, the return tool called `process.exit(0)` inside `execute`, killing the process before the loop could reach the `hasExplicitReturn` check.

## Decision

A three-part fix:

### 1. Move `_runtime` before plugin registration

`capabilities.set('_runtime', { subagentId, persona, isSubagent, flags })` now runs at the top of `initialize()`, before the plugin registration loop, so plugins can `request('runtime')` synchronously during `register()`.

### 2. Rename the return tool + fix `hasExplicitReturn`

- Renamed the return tool from `'subagent.return'` → `'return'`, so the canonical name is now `subagent__return` (dot-free, no doubled prefix).
- `hasExplicitReturn` in `interactive.ts` now iterates `toolCallBatch` events and compares each `tc.name` against `'subagent__return'`.
- Updated the prompt fragment text and all `subagent.return` references across source, tests, and vitest configs.

### 3. Stop-loop signal instead of `process.exit(0)`

Added a `DroneToolExecutionContext` type to drone-core:

```typescript
export type DroneToolExecutionContext = {
  /** Signal the conversation loop to stop after processing the current tool batch. */
  stopLoop?: () => void;
};
```

- `DroneToolDefinition.execute` gained an optional `context?: DroneToolExecutionContext` parameter.
- `DronePluginEngine.executeTool` and `DroneSlashCommandContext.engine.executeTool` thread the optional context through.
- The conversation service's `executeToolSafely` passes the context to the engine; the `sendUserMessage` loop tracks a `shouldStopLoop` flag. When any tool calls `context.stopLoop()`, the loop breaks after the current tool batch (after tool results are appended and `onAfterToolCall` hooks run), returning `response.message ?? ''`.
- The return tool now writes the NDJSON `return` event, calls `context?.stopLoop?.()`, and returns a normal result string instead of calling `process.exit(0)`.

## Consequences

- Subagents can now explicitly return via the `subagent__return` tool — the tool is actually registered in subagent mode, and the loop exits gracefully instead of the process dying mid-tool.
- `hasExplicitReturn` now functions, so when a subagent explicitly returns, the implicit return is NOT emitted (no duplicate).
- The `stopLoop` mechanism is generic and reusable — it opens the door for other "exit" tools in the future.
- Cleaner architecture: no `process.exit` inside a tool; the conversation service owns loop termination.

## Tests

6 new tests across 3 files:
- `plugin-engine.test.ts` — `_runtime` capability available during `register()` (main + subagent modes)
- `subagent-plugin.test.ts` (new) — return tool named `'return'` in subagent mode (not `dispatch`), prompt references `subagent__return`; return tool calls `stopLoop()` instead of `process.exit`; `dispatch` registered in main-agent mode
- `conversation-service.test.ts` — loop breaks when a tool calls `context.stopLoop()` (provider called only once); `toolCallBatch` exposes canonical `subagent__return` name (so `hasExplicitReturn` matches)

## Related

- subagent — Subagent system
- tool-call-loop — Tool-call loop with the new stop-loop break
- [DronePlugin](../../drone-core/src/plugin-system.ts) — `DroneToolExecutionContext` on `DroneToolDefinition.execute`
- [071-tool-consolidation-batch-2](071-tool-consolidation-batch-2.md) — Prior pokemon-name fix for `subagent__dispatch`
- [104-subagent-activity-timeout-and-error-detection](104-subagent-activity-timeout-and-error-detection.md) — Activity timeout, hard cap, error detection

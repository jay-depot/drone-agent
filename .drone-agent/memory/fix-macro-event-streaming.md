---
key: fix-macro-event-streaming
tags:
  - plan
  - fix
  - macros
  - tui
  - conversation-service
created: 2026-07-06T19:12:35.450Z
updated: 2026-07-06T19:12:35.450Z
---

# Plan: Fix Macro Event Streaming Regression (Message Queue Refactor)

## Summary

The message queue + soft cancel refactor (commit `5e9e263`) regressed two things that were working after the original macro event streaming fix (commit `5b51a3a`):

1. **Thinking indicator doesn't activate** during macro execution — `setIsLlmActive` wrapping around `dispatchSlashCommand` was lost in the restructure
2. **All macro output shows in white** — the macro's `onEvent` callback logs everything through `ctx.logger.info(...)`, which the TUI maps to `'user'` kind (white with `> ` prefix), losing color differentiation for reasoning (gray), tool calls (gray), and assistant messages

## Root Cause

The message queue commit restructured `app.tsx`'s `runSlashCommand` and `onSubmit` handlers. The `setIsLlmActive(true/false)` wrapping around `dispatchSlashCommand` was dropped. Separately, the macro's `onEvent` callback duplicates the conversation event routing that `sendUserMessage` already does via `engine.runConversationEventHooks(event)`, but through a lossy channel (`ctx.logger.info` → `'user'` kind).

## Solution: Unify on Engine Conversation Event Hooks

Instead of the macro plugin re-logging events through `ctx.logger` (which loses color info), the TUI should listen to the engine's conversation event hooks directly. This way **all** conversation events from any source (regular messages, macro chatPrompt steps, any future plugin) flow through the same handler with proper color-coding.

## Files to Modify

### 1. `drone-agent/src/runtime/plugin-engine.ts`

**Change:** Add `onConversationEvent` to the public `DronePluginEngine` type.

The `DronePluginRegistration` type already has `onConversationEvent(callback) => () => void` for plugins to register hooks. The engine stores these in `conversationEventHooks[]` and exposes them via `runConversationEventHooks`. We need to expose the registration function on the public engine interface so the TUI can register its own listener.

```typescript
// In the DronePluginEngine type (around line 72):
onConversationEvent?: (
  callback: (event: DroneConversationEvent) => void
) => () => void;
```

The implementation already exists internally — it's the same function returned by `registration.hooks.onConversationEvent`. We just need to expose it.

### 2. `drone-agent/src/tui/types.ts`

**Change:** Add `onConversationEvent` to the engine handle in `DroneTuiOptions`.

```typescript
// In the engine Pick<> type (around line 88):
| 'onConversationEvent'
```

### 3. `drone-agent/src/tui/app.tsx`

**Change A:** Register a conversation event listener on mount that logs events with proper `ChatEntry` kinds.

```typescript
// New useEffect — register conversation event listener
useEffect(() => {
  const unregister = opts.engine.onConversationEvent?.(event => {
    switch (event.kind) {
      case 'reasoning': {
        const trimmed = event.content.trim();
        if (trimmed.length > 0) {
          log(`💭 ${trimmed}`, 'reasoning');
        }
        break;
      }
      case 'toolCall': {
        const argsPreview = preview(
          JSON.stringify(event.arguments),
          PREVIEW_MAX
        );
        log(`→ tool: ${event.name} ${argsPreview}`, 'toolCall');
        break;
      }
      case 'toolResult': {
        let resultContent: string;
        if (event.name === 'exec__run') {
          resultContent = formatExecResult(event.arguments, event.content);
        } else if (event.name === 'file__apply_diff' || event.name === 'git__diff') {
          resultContent = formatDiffResult(event.content);
        } else {
          resultContent = preview(event.content, PREVIEW_MAX);
        }
        log(`← ${event.name}:\n${resultContent}`, 'toolResult');
        break;
      }
      case 'assistantMessage': {
        log(event.content, 'plain');
        break;
      }
      case 'error': {
        log(`Error: ${event.message}`, 'error');
        break;
      }
    }
  });
  return () => unregister?.();
}, [opts.engine, log]);
```

**Change B:** Wrap `dispatchSlashCommand` in `setIsLlmActive(true/false)`.

```typescript
// In runSlashCommand, around line 255:
if (trimmed.startsWith('/')) {
  setIsLlmActive(true);
  try {
    const handled = await opts.engine.dispatchSlashCommand(trimmed, {
      logger: {
        info: msg => log(msg, 'user'),
        warn: msg => log(msg, 'error'),
        error: msg => log(msg, 'error'),
      },
      engine: opts.engine,
      conversation: opts.conversation,
      sessionManager: undefined,
      exit: () => exit(),
      printHelp: () => printHelp(opts, log),
    });
    if (handled) return;
    log(
      `Unknown command: ${trimmed}. Type /help for available commands.`,
      'error'
    );
    return;
  } finally {
    setIsLlmActive(false);
  }
}
```

**Change C:** Remove the `onEvent` callback from the regular message path's `sendUserMessage` call, since the engine hook listener now handles it. The `assistantRendered` tracking and the `CANCEL_SENTINEL` check remain.

```typescript
// In runSlashCommand, around line 335 — the regular message path:
setIsLlmActive(true);
try {
  await opts.engine.runHooks('onBeforePrompt');
  const response = await opts.conversation.sendUserMessage(trimmed);
  // No onEvent callback needed — engine hooks handle it

  if (response === CANCEL_SENTINEL) {
    return;
  }

  if (response.length > 0) {
    log(response, 'plain');
  }
  await opts.engine.runHooks('onAfterToolCall');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  log(`Error: ${msg}`, 'error');
} finally {
  setIsLlmActive(false);
}
```

### 4. `drone-agent/src/plugins/macros/index.ts`

**Change:** Remove the `onEvent` callback from the `sendUserMessage` call. The events will still fire through engine conversation event hooks. Keep the reply handling and the `onBeforePrompt`/`onAfterToolCall` hooks.

```typescript
// In executeMacro, the chatPrompt step (around line 100):
// chatPrompt step
const substituted = substituteMacroArgs(step.text, ctx.args, macro);
ctx.logger.info(substituted);
if (ctx.conversation) {
  await ctx.engine.runHooks?.('onBeforePrompt');
  const reply = await ctx.conversation.sendUserMessage(substituted);
  if (reply.length > 0) {
    ctx.logger.info(reply);
  }
  await ctx.engine.runHooks?.('onAfterToolCall');
} else {
  ctx.sessionManager?.appendUserMessage(substituted);
}
```

### 5. `drone-agent/src/interactive.ts`

**Change:** Add `onConversationEvent` to the engine handle for type consistency. The readline mode doesn't need to display events, but the type should match.

```typescript
// In the engine object passed to dispatchSlashCommand (around line 300):
engine: {
  executeTool: (name, input) => engine.executeTool(name, input),
  runWorkflow: (name, args) => engine.runWorkflow(name, args),
  runHooks: hookName => engine.runHooks(hookName),
  getCapability: <T>(id: string) => engine.getCapability<T>(id),
  dispatchSlashCommand: (l, ctx) => engine.dispatchSlashCommand(l, ctx),
  onConversationEvent: (cb) => engine.onConversationEvent?.(cb),
},
```

### 6. `drone-agent/test/macros.test.ts`

**Change:** Update the test "logs chatPrompt text and streams events from sendUserMessage" to verify events through the engine's conversation event hooks instead of through the `onEvent` callback.

The test currently mocks `sendUserMessage` with an `onEvent` callback and checks that events appear in `infoMessages`. Instead, register a conversation event hook on the engine and verify events arrive there.

### 7. `drone-agent/test/tui.test.tsx`

**Change:** If there are existing TUI tests that mock the engine, add `onConversationEvent` to the mock. Check if any tests break due to the removed `onEvent` callback from the regular message path.

## Validation Criteria

1. `pnpm typecheck` — no TypeScript errors
2. `pnpm build` — all packages compile
3. `pnpm test` — all existing tests pass, including updated macro tests
4. Manual verification:
   - Run a macro with a `chatPrompt` step → thinking indicator activates
   - Reasoning appears in gray (`💭`), tool calls in gray (`→`), assistant messages in white
   - Regular (non-macro) messages still work correctly with same color scheme
   - `/cancel` and ESC still work during macro execution
   - Readline mode (`--output-plain`) still works for macros

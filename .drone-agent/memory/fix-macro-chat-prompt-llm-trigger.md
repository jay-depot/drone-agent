---
key: fix-macro-chat-prompt-llm-trigger
tags:
  - plan
  - bugfix
  - macros
created: 2026-07-29T00:22:26.067Z
updated: 2026-07-29T00:22:26.067Z
---

# Fix Macro Chat Prompt Steps Not Triggering LLM Response

## Summary

When a macro has a `chatPrompt` step (a non-slash-command line), the current code calls `ctx.conversation.enqueueUserMessage(substituted)` which just pushes the message to a queue. That queue is only drained when `sendUserMessage` is called — which only happens when the user types a regular message. The macro handler returns `true`, the TUI's `runSlashCommand` returns, and the LLM never gets invoked.

The fix is to call `sendUserMessage` directly (as the original code did before the conversation-loop refactor), which blocks the macro handler until the LLM finishes responding. While we're in there, we'll also restore the `onBeforePrompt`/`onAfterToolCall` lifecycle hooks and clean up the `dispatchSlashCommand` context construction.

## Branch

`fix/macro-chat-prompt-not-triggering-llm`

## Step-by-Step Implementation

### Step 1: Restore `sendUserMessage` with event handler in macro chat prompt step

**File:** `drone-agent/src/plugins/macros/index.ts`

**Location:** The `else` branch inside the `for (const step of macro.steps)` loop (currently lines 97-108).

**Change:** Replace the `enqueueUserMessage` call with `sendUserMessage`, including an event handler that logs events to `ctxLogger` (info for assistant messages, warn for errors, etc.), and wrap it with `onBeforePrompt`/`onAfterToolCall` hooks.

The event handler should handle these event kinds (matching `DroneConversationEvent`):

- `reasoning` → log with a `💭` prefix
- `toolCall` → log with `→ tool:` prefix
- `toolResult` → log with `←` prefix (truncate content to 200 chars)
- `assistantMessage` → log the content
- `error` → log with `Error:` prefix

After `sendUserMessage` resolves, log the reply if non-empty.

**Rough code:**

```typescript
} else {
  // Chat prompt: send to conversation and wait for response.
  const substituted = substituteMacroArgs(step.text, args, macro);
  ctxLogger.info(substituted);
  if (ctx.conversation?.sendUserMessage) {
    await ctx.engine.runHooks?.('onBeforePrompt');
    const reply = await ctx.conversation.sendUserMessage(
      substituted,
      (event: DroneConversationEvent) => {
        switch (event.kind) {
          case 'reasoning':
            ctxLogger.info(`💭 ${event.content}`);
            break;
          case 'toolCall':
            ctxLogger.info(
              `→ tool: ${event.name} ${JSON.stringify(event.arguments)}`
            );
            break;
          case 'toolResult':
            ctxLogger.info(
              `← ${event.name}: ${event.content.slice(0, 200)}`
            );
            break;
          case 'assistantMessage':
            ctxLogger.info(event.content);
            break;
          case 'error':
            ctxLogger.warn(`Error: ${event.message}`);
            break;
        }
      }
    );
    if (reply.length > 0) {
      ctxLogger.info(reply);
    }
    await ctx.engine.runHooks?.('onAfterToolCall');
  } else {
    // Fallback: append as user message if no conversation available.
    ctx.sessionManager?.appendUserMessage(substituted);
  }
}
```

**Note:** The `DroneConversationEvent` type is already exported from `drone-core` — import it at the top of the file.

### Step 2: Clean up `dispatchSlashCommand` context construction

**File:** `drone-agent/src/plugins/macros/index.ts`

**Location:** The `slashCommand` step handler (currently lines 74-91).

**Change:** The current code constructs a new context object with only `{ logger, engine, conversation, sessionManager, exit, printHelp }`. The old code passed `ctx` directly. Since the engine's `dispatchSlashCommand` does `{ ...ctx, line, args }` (overwriting `line` and `args`), passing the full `ctx` is cleaner and avoids unnecessary object allocation.

Replace:

```typescript
const handled = await ctx.engine.dispatchSlashCommand(substituted, {
  logger: ctx.logger,
  engine: ctx.engine,
  conversation: ctx.conversation,
  sessionManager: ctx.sessionManager,
  exit: ctx.exit,
  printHelp: ctx.printHelp,
});
```

With:

```typescript
const handled = await ctx.engine.dispatchSlashCommand(substituted, ctx);
```

### Step 3: Update the test that asserts `enqueueUserMessage` behavior

**File:** `drone-agent/test/macros.test.ts`

**Location:** The test `'logs chatPrompt text and streams events through engine hooks'` (around line 650).

**Change:** This test currently asserts `capturedEvents.length === 0` with a comment explaining that the macro enqueues rather than calling `sendUserMessage`. After the fix, the macro _does_ call `sendUserMessage`, so events will flow through. Update the test to:

1. Have the mock `sendUserMessage` fire events via `engine.runConversationEventHooks` (it already does this)
2. Assert that `capturedEvents` contains the expected events (reasoning, toolCall, toolResult, assistantMessage)
3. Assert that the reply from `sendUserMessage` is logged via `infoMessages`

**Rough assertion changes:**

```typescript
// The substituted prompt text should be logged
expect(infoMessages[0]).toBe('What is the meaning of life?');

// Events should be streamed through engine hooks
expect(capturedEvents.length).toBeGreaterThan(0);
expect(capturedEvents[0].kind).toBe('reasoning');
expect(capturedEvents[1].kind).toBe('toolCall');
expect(capturedEvents[2].kind).toBe('toolResult');
expect(capturedEvents[3].kind).toBe('assistantMessage');

// The reply should be logged
expect(infoMessages[1]).toBe('42');
```

### Step 4: Add import for `DroneConversationEvent`

**File:** `drone-agent/src/plugins/macros/index.ts`

Add to the existing imports:

```typescript
import type { DroneConversationEvent } from 'drone-core';
```

### Step 5: Verify everything compiles and tests pass

```bash
pnpm typecheck
pnpm test
pnpm lint
```

## Validation Criteria

1. **LSP checks pass** — `pnpm typecheck` across all packages with zero errors
2. **All tests pass** — `pnpm test` passes (no regressions)
3. **Lint passes** — `pnpm lint` passes with zero errors
4. **Manual smoke test:**
   - Run the TUI
   - Type `/execute-plan some-plan-name` (or any macro with a chat prompt step)
   - Verify the LLM responds immediately (no need to send a second message)
   - Verify the `onBeforePrompt`/`onAfterToolCall` hooks fire (compaction, logging, etc. work)
5. **Existing macro behavior preserved:**
   - Macros with only slash command steps still work
   - Argument substitution still works across all steps
   - Missing required args still produce helpful error messages
   - `/macro list`, `/macro show`, `/macro reload` still work

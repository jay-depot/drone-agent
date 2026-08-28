---
key: fix-macro-duplicate-rendering
tags:
  []
created: 2026-08-28T01:57:32.789Z
updated: 2026-08-28T01:57:32.789Z
---

# Fix: Macro double-renders reasoning/assistantMessage with `>`

## Summary
While a macro executes, the `reasoning` and `assistantMessage` parts of every response display twice in the TUI — once normally (color-coded, tail region) and once with the `>` prefix that normally denotes user input. This is a regression from commit `d62ac7697`, which re-introduced a per-call `onEvent` callback in the macro's chat-prompt step that `d62ac7697`'s predecessor `18406f05` had deliberately removed in favor of engine-hook streaming.

## Root Cause
Two rendering channels collide during a macro chat-prompt step:
1. TUI global listener (`app.tsx` `opts.engine.onConversationEvent`, ~line 194) renders `reasoning`, `assistantMessage`, `toolCallBatch`, `toolResultBatch` correctly.
2. Macro's `onEvent` callback (`macros/index.ts`, chat-prompt step ~lines 130-153) re-logs the *singular* `reasoning` and `assistantMessage` events via `ctx.logger.info(...)`. In the TUI, slash-command `logger.info` → `log(msg, 'user')` → renders with `> ` prefix.

Only reasoning+assistantMessage double because tools are emitted as `toolCallBatch`/`toolResultBatch`, which the macro's `switch` does not match (only the singular kinds it does match — `reasoning`/`assistantMessage` — plus never-firing `toolCall`/`toolResult`). A third redundant line comes from `ctxLogger.info(reply)` logging the `sendUserMessage` return value on top of the already-rendered assistantMessage.

Complication: the console/readline host (`interactive.ts` `runInteractiveLoop`) does NOT register a global `onConversationEvent` listener, so in console mode the macro's onEvent logging is currently the ONLY thing that shows macro streaming + reply. Deleting the onEvent naively fixes the TUI but regresses console macro streaming.

## Plan
1. `drone-agent/src/plugins/macros/index.ts`: remove the `onEvent` callback from `ctx.conversation.sendUserMessage(substituted, ...)` → `sendUserMessage(substituted)`; remove `if (reply.length > 0) ctxLogger.info(reply)`; remove now-unused `DroneConversationEvent` import. Keep `ctxLogger.info(substituted)` (intended `>` echo of the synthetic prompt) and the `onBeforePrompt`/`onAfterToolCall` hooks.
2. `drone-agent/src/output-handlers.ts`: extend `makePlainOutputEventHandler` with a `renderAssistantMessage = false` flag; when true, the `assistantMessage` case writes content to stdout (backward compatible — default callers unchanged).
3. `drone-agent/src/interactive.ts` `runInteractiveLoop`: register a global `engine.onConversationEvent?.(makePlainOutputEventHandler({ renderAssistantMessage: true }))` at loop start (store unsubscribe); in the regular-message path remove the per-call `makePlainOutputEventHandler()` and `output.write(response)` (the global listener now renders assistantMessage). Keeps console macro streaming working after #1 and prevents the same double-render in console mode.
4. Tests:
   - `test/macros.test.ts`: update "logs chatPrompt text and streams events through engine hooks" — assert `infoMessages` equals `['What is the meaning of life?']` (prompt only, NOT reasoning/assistant/reply); keep capturedEvents-through-engine-hooks assertions.
   - New `test/output-handlers.test.ts`: unit test that `makePlainOutputEventHandler({ renderAssistantMessage: true })` writes assistantMessage content; and that the default (false) suppresses it.

## Validation Criteria
- LSP diagnostics clean (typescript).
- `pnpm -r run build` passes.
- `pnpm lint` passes.
- `pnpm test` passes (fast suite).
- Regression test in macros.test.ts fails before the fix (asserts no reasoning/assistant/reply in logger output).

---
tags: [decision, macros, tui, console, conversation, bug-fix]
related: [decisions/045-macro-event-streaming-unified-hooks.md, decisions/094-macro-chat-prompt-llm-trigger-fix.md, modules/drone-agent.md, modules/drone-agent-tui.md, modules/drone-agent-plugins.md, decisions/236-tui-final-reply-dedup.md]
---

# 168: Macro duplicate-render fix — re-unify conversation event streaming

**Status**: Implemented (2026-08-27, branch `feat/duplicate-text-fix`, commit `65c9a16`)

## Problem

While a macro executes, the `reasoning` and `assistantMessage` parts of every response displayed **twice** in the TUI — once normally (color-coded, in the tail region) and once prefixed with `>` (which normally denotes user input). A redundant third copy of the assistant reply also appeared.

## Root Cause

Two rendering channels collided during a macro's `chatPrompt` step:

1. **TUI global listener** — `app.tsx` registers `opts.engine.onConversationEvent(...)`, which renders `reasoning`, `assistantMessage`, `toolCallBatch`, and `toolResultBatch` correctly with proper color-coding in the tail region.
2. **Macro's per-call `onEvent` callback** — `macros/index.ts` passed an `onEvent` to `sendUserMessage` that re-logged the *singular* `reasoning` and `assistantMessage` events via `ctx.logger.info(...)`. In the TUI, slash-command `logger.info` maps to `log(msg, 'user')`, which renders with the `>` prefix. This produced the duplicate.

Only `reasoning` and `assistantMessage` doubled (not tools) because the conversation service emits tools as `toolCallBatch`/`toolResultBatch` — which the callback's `switch` never matched — while `reasoning` and `assistantMessage` are emitted as singular events. A further redundant line came from `ctxLogger.info(reply)`, which logged the `sendUserMessage` return value on top of the already-rendered `assistantMessage`.

## History

This was a **regression of ADR 045** ([045-macro-event-streaming-unified-hooks](045-macro-event-streaming-unified-hooks.md), commit `18406f0`), which had deliberately removed the macro's inline `onEvent` callback in favor of unified engine-hook streaming:

- **ADR 045** unified all conversation event streaming through the engine's `onConversationEvent` hooks, removing the macro's inline event handler (which logged everything through the lossy `DroneLogger` and rendered it as `>` user input).
- **ADR 094** ([094-macro-chat-prompt-llm-trigger-fix](094-macro-chat-prompt-llm-trigger-fix.md), commit `d62ac76`) re-introduced the inline `onEvent` callback in order to fix a separate regression (macro chat-prompt steps not triggering the LLM). This re-introduced the double-render ADR 045 had fixed.

The complication: the console/readline host (`interactive.ts` `runInteractiveLoop`) did **not** register a global `onConversationEvent` listener, so in console mode the macro's `onEvent` logging was the *only* thing that showed macro streaming + reply. Removing the callback naively would have fixed the TUI but **regressed console-mode macro streaming**.

## Decision

Re-unify event streaming through engine hooks, and give the console host a global listener so console-mode macro streaming is preserved.

### 1. `macros/index.ts` — drop the per-call `onEvent` callback

Chat-prompt steps now call `ctx.conversation.sendUserMessage(substituted)` with **no** handler — conversation events flow only through engine hooks (restoring the ADR 045 design). Removed:
- the `onEvent` callback (the whole `switch` over `reasoning`/`toolCall`/`toolResult`/`assistantMessage`/`error`),
- the `if (reply.length > 0) ctxLogger.info(reply)` reply log (already rendered via the `assistantMessage` event),
- the now-unused `DroneConversationEvent` import.

Kept: `ctxLogger.info(substituted)` (the intended `>` echo of the synthetic prompt) and the `onBeforePrompt`/`onAfterToolCall` lifecycle hooks.

### 2. `output-handlers.ts` — backward-compatible `renderAssistantMessage` option

`makePlainOutputEventHandler` now accepts an optional `{ renderAssistantMessage?: boolean }` (default `false`). When `true`, the `assistantMessage` case writes the content to stdout. Default callers (`index.tsx` chat/workflow paths, NDJSON) are unchanged.

This is needed because the console host has no caller-side reply print once it uses the global listener — the listener itself must render the assistant reply.

### 3. `interactive.ts` `runInteractiveLoop` — console global listener

At loop start, register a global `engine.onConversationEvent?.(makePlainOutputEventHandler({ renderAssistantMessage: true }))` (unsubscribed in the `finally`). In the regular-message path, removed the per-call `makePlainOutputEventHandler()` handler and the `output.write(\`${response}\n\`)` reply print — the global listener now renders the assistant reply and tool events. This:
- **preserves** console-mode macro streaming (the global listener handles events from any source, including macro chat-prompt steps),
- **prevents the same double-render in console mode** (the regular-message path no longer prints both the per-call handler output AND the reply).

### Why a global console listener rather than a macro-side handler

A macro-side handler would fix the TUI but leave console mode with no streaming. Registering the listener once on the console host (mirroring the TUI's mount-time listener) gives every source — regular messages, macro steps, any future plugin — a single rendering path, exactly as ADR 045 intended. The `renderAssistantMessage` flag makes the plain-output handler reusable both as a per-call handler (suppress reply, caller prints it) and as a global listener (render reply itself).

## Files Changed

- `drone-agent/src/plugins/macros/index.ts` — removed inline `onEvent` callback + reply log + unused import
- `drone-agent/src/output-handlers.ts` — `makePlainOutputEventHandler` gains `renderAssistantMessage` option
- `drone-agent/src/interactive.ts` — `runInteractiveLoop` registers a global conversation event listener; regular-message path no longer double-prints
- `drone-agent/test/macros.test.ts` — regression now asserts only the prompt text is logged (no reasoning/assistant/reply re-logging)
- `drone-agent/test/output-handlers.test.ts` — new test covering the `renderAssistantMessage` flag (default suppression, `true` renders, other kinds unaffected)

## Validation

Full fast suite green (2300 passed / 9 skipped), `pnpm -r run build` + `pnpm lint` clean, LSP clean (no errors workspace-wide). The updated macro regression test was verified to **fail against the pre-fix code** and pass with the fix.

## Related

- [045-macro-event-streaming-unified-hooks](045-macro-event-streaming-unified-hooks.md) — the design this fix re-affirms and extends (console host now gets a global listener too)
- [094-macro-chat-prompt-llm-trigger-fix](094-macro-chat-prompt-llm-trigger-fix.md) — re-introduced the inline callback this fix removes; its `onEvent` logging half is superseded
- [236-tui-final-reply-dedup](236-tui-final-reply-dedup.md) — the TUI's exactly-once final-reply render this fix extends to macros
- [drone-agent](../../drone-agent/) — `interactive.ts` + `output-handlers.ts`
- [drone-agent-tui](../../drone-agent/src/tui/) — TUI event streaming
- [drone-agent-plugins](../../drone-agent/src/plugins/) — macros plugin

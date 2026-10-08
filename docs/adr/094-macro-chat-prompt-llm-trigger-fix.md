---
tags: [decision, macros, bug-fix, conversation]
related:
  [
    decisions/040-message-queue-cancel.md,
    decisions/045-macro-event-streaming-unified-hooks.md,
    decisions/086-macro-argument-reuse.md,
    modules/drone-agent-plugins.md,
  ]
---

# Decision 094: Macro Chat Prompt LLM Trigger Fix — Restore `sendUserMessage` with Lifecycle Hooks

**Status**: Implemented on branch `fix/macro-chat-prompt-not-triggering-llm`, commit `7a53ace`.

> **Superseded (2026-08-27, [168-macro-duplicate-render-fix](168-macro-duplicate-render-fix.md))**: the event-logging half of this fix (the inline `onEvent` callback in the chat-prompt step) is **undone**. It re-introduced the double-render of `reasoning`/`assistantMessage` that ADR 045 had removed. The `sendUserMessage`-without-callback + lifecycle-hooks behavior this fix restored is kept, but events now flow only through engine hooks (a console global listener preserves console-mode streaming).

## Problem

When a macro has a `chatPrompt` step (a non-slash-command line), the code called `ctx.conversation.enqueueUserMessage(substituted)` which just pushed the message to a queue. That queue is only drained when `sendUserMessage` is called — which only happens when the user types a regular message. The macro handler returned `true`, the TUI's `runSlashCommand` returned, and the LLM never got invoked.

## Root Cause

Commit `5e9e263` (ADR 040, "conversation loop: message queue + soft cancel") refactored the conversation service to add `enqueueUserMessage` and `cancelCurrentRequest`. The macros plugin was updated to use `enqueueUserMessage` instead of `sendUserMessage` for chat prompt steps, but the macro handler returns `true` and the TUI's `runSlashCommand` returns — nobody ever calls `sendUserMessage` to drain the queue.

This was a regression of the original working behavior from commit `5b51a3a` (ADR 045), which had `sendUserMessage` with an inline event handler.

## Solution

Three changes were made to `drone-agent/src/plugins/macros/index.ts`:

### 1. Restore `sendUserMessage` with Event Handler

Replaced `enqueueUserMessage` with `sendUserMessage`, including an event handler that logs events to the macro's logger:

- `reasoning` → logged with `💭` prefix
- `toolCall` → logged with `→ tool:` prefix
- `toolResult` → logged with `←` prefix (content truncated to 200 chars)
- `assistantMessage` → logged directly
- `error` → logged with `Error:` prefix

### 2. Restore Lifecycle Hooks

Wrapped the `sendUserMessage` call with `onBeforePrompt` and `onAfterToolCall` hooks, which were also lost in the ADR 040 refactor. This ensures compaction, logging, and other hook-dependent plugins fire correctly for macro chat prompts.

### 3. Clean Up `dispatchSlashCommand` Context

The slash command step handler was constructing a new context object with only `{ logger, engine, conversation, sessionManager, exit, printHelp }`. Changed to pass `ctx` directly — the engine's `dispatchSlashCommand` does `{ ...ctx, line, args }` which overwrites `line` and `args` anyway, so the subset construction was unnecessary object churn.

### 4. Add `DroneConversationEvent` Import

Added the typed import for the event handler, with a cast from `unknown` (since `DroneSlashCommandContext.conversation.sendUserMessage` types its `onEvent` parameter as `(event: unknown) => void`).

## Files Changed

- `drone-agent/src/plugins/macros/index.ts` — All four changes above
- `drone-agent/test/macros.test.ts` — Updated test to assert events flow through engine hooks and reply is logged

## Validation

- `pnpm typecheck` — passes
- `pnpm test` — 1636/1636 tests pass
- `pnpm lint` — passes

## Related

- [040-message-queue-cancel](040-message-queue-cancel.md) — The refactor that introduced the regression
- [045-macro-event-streaming-unified-hooks](045-macro-event-streaming-unified-hooks.md) — Previous macro event streaming fix (also regressed by ADR 040)
- [086-macro-argument-reuse](086-macro-argument-reuse.md) — Previous macro parser fix
- [168-macro-duplicate-render-fix](168-macro-duplicate-render-fix.md) — Undoes this fix's event-logging half (re-unifies engine-hook streaming)
- [drone-agent-plugins](../../drone-agent/src/plugins/) — Macros plugin documentation

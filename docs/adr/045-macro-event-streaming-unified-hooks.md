---
tags: [decision, macros, tui, conversation]
related: [023-conversation-event-push-through.md, 040-message-queue-cancel.md, flows/tool-call-loop.md, modules/drone-agent-tui.md, decisions/168-macro-duplicate-render-fix.md]
---

# ADR 045: Unify Conversation Event Streaming Through Engine Hooks

**Status**: Implemented (2026-07-06, commit `18406f0`)

## Context

The message queue + soft cancel refactor (ADR 040, commit `5e9e263`) regressed two things that were working after the original macro event streaming fix (commit `5b51a3a`):

1. **Thinking indicator didn't activate** during macro execution — `setIsLlmActive` wrapping around `dispatchSlashCommand` was lost in the restructure
2. **All macro output showed in white** — the macro's `onEvent` callback logged everything through `ctx.logger.info(...)`, which the TUI mapped to `'user'` kind (white with `> ` prefix), losing color differentiation for reasoning (gray), tool calls (gray), and assistant messages

The root cause was that the macro plugin was re-logging conversation events through the `DroneLogger` interface (which only has `info`/`warn`/`error` levels), while the TUI's regular message path used an `onEvent` callback with proper `ChatEntry` kinds. These were two separate code paths for the same kind of data.

## Decision

Unify all conversation event streaming through the engine's conversation event hooks. Instead of each source (regular messages, macro `chatPrompt` steps) having its own event handling, a single listener on the engine handles all events with proper color-coding.

### Key Changes

1. **Expose `onConversationEvent` on the public engine type** — The `DronePluginEngine` type already had `runConversationEventHooks` for internal plugin hooks, but no way for external code (like the TUI) to register listeners. Added an `externalConversationEventListeners` array alongside the existing `conversationEventHooks`. The `runConversationEventHooks` method now notifies both.

2. **TUI registers a single listener on mount** — A `useEffect` in `app.tsx` calls `opts.engine.onConversationEvent(callback)` and returns the unsubscribe function for cleanup. The callback maps event kinds to `ChatEntry` kinds with the same logic that was previously in the inline `onEvent` callback.

3. **Wrap `dispatchSlashCommand` in `setIsLlmActive`** — Restored the `setIsLlmActive(true/false)` wrapping around `dispatchSlashCommand` that was lost in the message queue refactor. This reactivates the thinking indicator during macro execution.

4. **Remove inline `onEvent` callbacks** — Both the TUI's regular message path and the macro plugin's `chatPrompt` step no longer pass an `onEvent` callback to `sendUserMessage`. The engine hook listener handles all events.

5. **Type consistency** — Added `onConversationEvent` to the `DroneSlashCommandContext.engine` type in `drone-core` and to the engine handle in `interactive.ts` and `tui/types.ts`.

## Consequences

### Positive

- **Single source of truth** — All conversation events from any source (regular messages, macro `chatPrompt` steps, any future plugin) flow through the same handler with proper color-coding
- **Thinking indicator works** — Macro execution now shows the LLM active indicator
- **Proper colors** — Reasoning appears in gray (`💭`), tool calls in gray (`→`), assistant messages in white, errors in red
- **Cleaner code** — The macro plugin no longer needs to re-log events through the lossy `DroneLogger` interface
- **Extensible** — Any future plugin that calls `sendUserMessage` automatically gets proper TUI event display without additional wiring

### Negative

- **Slightly more complex engine API** — The `DronePluginEngine` type now has an additional public method
- **TUI tests needed mock updates** — All test mocks that create a fake engine needed `onConversationEvent` added

## Related

- [023-conversation-event-push-through](023-conversation-event-push-through.md) — Original `onConversationEvent` hook design
- [040-message-queue-cancel](040-message-queue-cancel.md) — The refactor that caused the regression
- tool-call-loop — Hook ordering in the conversation loop
- [drone-agent-tui](../../drone-agent/src/tui/) — TUI event handling
- [168-macro-duplicate-render-fix](168-macro-duplicate-render-fix.md) — Re-affirms + extends this design (console host now gets a global listener too)

---
tags: [decision, swarm, events]
related: [022-swarm-websocket-shutdown-guard.md, 024-swarm-event-push-404-fix.md, flows/tool-call-loop.md, entities/DronePlugin.md]
---

# 023 — Conversation Event Push-Through

**Status**: Implemented (2026-06-30, commit `94f8572`)

## Context

The swarm plugin declared an `eventBuffer` and a `flushEventBuffer()` function, and registered `onBeforePrompt` and `onAfterToolCall` hooks — but nothing ever pushed events into the buffer. Conversation events (user messages, reasoning, tool calls, results) were only delivered to the TUI via the `onEvent` callback, never captured for swarm-wide session storage.

## Decision

Add a new `onConversationEvent` hook to the plugin system that carries a typed event payload, move the `ConversationEvent` type to `drone-core` as `DroneConversationEvent`, and wire the conversation service to fire events through the hook.

### Key Design Choices

1. **New hook type, not reuse of existing hooks** — `onConversationEvent` carries a payload (the event), so it follows the same pattern as `onSessionSafetyTrimWillRun` / `onSessionSafetyTrimApplied` with a dedicated engine method (`runConversationEventHooks`), not the generic `runHooks`.

2. **Fire-and-forget pattern** — The engine hook is called with `.catch()` so a slow or failing hook doesn't block the conversation loop. This is critical because the swarm plugin's event buffering should never slow down the agent.

3. **`userMessage` variant added** — The `DroneConversationEvent` type includes a `userMessage` kind (not present in the original local `ConversationEvent` type) so that user prompts are also captured in the event stream.

4. **Type moved to `drone-core`** — The `ConversationEvent` type was previously local to `conversation-service.ts`. Moving it to `drone-core` as `DroneConversationEvent` makes it available to all plugins for type-safe event handling.

## Consequences

- The swarm plugin now pushes conversation events into its buffer via the `onConversationEvent` hook
- Events are flushed to the coordinator after each tool iteration via the existing `onAfterToolCall` hook
- The `userMessage` event is fired immediately after `sessionManager.appendUserMessage()`, before the LLM is called
- All existing tests pass (808 tests, 47 files)
- The `DroneConversationEvent` type is now available in `drone-core` for any plugin to use

## Related

- [[024-swarm-event-push-404-fix]] — The beacon proxy routes that receive these events
- [[flows/tool-call-loop]] — Hook ordering in the conversation loop
- [[entities/DronePlugin]] — Plugin hook interface

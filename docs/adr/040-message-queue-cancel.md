---
tags: [decision, tui, conversation]
related:
  [
    flows/tool-call-loop.md,
    session-management.md,
    023-conversation-event-push-through.md,
  ]
---

# ADR 040: Message Queue & Soft Cancel for Conversation Service

**Status**: Accepted (2026-07-02)

## Context

The TUI called `sendUserMessage` via `void runSlashCommand(value)` — fire-and-forget. A fast typist could start a second `sendUserMessage` while the first was still in a tool chain, causing both invocations to share and interleave mutations on `sessionManager.turns[]`. The readline mode (`interactive.ts`) was safe because it blocks on `await rl.question(...)`, but the TUI had no such guard.

Additionally, the only way to stop a long-running tool chain was `Ctrl-C` (hard exit), which terminated the entire agent. There was no soft cancellation mechanism.

## Decision

Add a message queue and soft-cancel mechanism to the `ConversationService`, and wire the TUI to route input accordingly.

### Message Queue

A `pendingMessages: string[]` array is maintained in the conversation service. Messages are enqueued via `enqueueUserMessage(prompt)` and drained at two points:

1. **At the start of `sendUserMessage()`** — drains any leftover queue from a previous cancelled request (preserve policy)
2. **At the top of the `while(true)` loop** — after the budget key check, before building system messages

This means queued messages appear as new user turns in the LLM's view of conversation, appended at a consistent moment: after the previous LLM round's tool results are in the session and all `onAfterToolCall` hooks have run.

### Soft Cancel

A `cancelled: boolean` flag is checked at the top of the `while(true)` loop. When set, `sendUserMessage` returns the `CANCEL_SENTINEL` string (`'__CANCELLED__'`). The flag is reset after the check.

### TUI Routing

The TUI's `onSubmit` handler checks `isLlmActive`:

- If the LLM is active and the input is `/cancel` → calls `cancelCurrentRequest()`, logs "Cancelled"
- If the LLM is active and the input is a plain message → calls `enqueueUserMessage()`, logs the message as a user entry
- If the LLM is idle → normal path (`runSlashCommand` → `sendUserMessage`)

### ESC Keybinding

ESC when the LLM is active → soft cancel. ESC when idle → no-op (the previous behavior was to exit). `Ctrl-C` remains the only keyboard exit.

### Slash Command Context

The `DroneSlashCommandContext.conversation` type was extended with optional `enqueueUserMessage?` and `cancelCurrentRequest?` methods.

## Key Design Decisions

- **Cancel preserves the queue.** Messages queued before a `/cancel` survive and are drained on the next `sendUserMessage` call.
- **Slash commands that touch session/LLM state** (`/clear`, `/exec`, `/tool`) are blocked when the LLM is active — they can only be submitted when idle. `/cancel` is the only slash command that fires during activity.
- **Read-only slash commands** (`/help`, `/plugins`, `/tools`, `/systemprompt`) could in theory be allowed while active, but for simplicity the first pass treats all slash commands as "must wait for LLM."
- **`clearSession()` flushes the queue** — both `pendingMessages` and `cancelled` are reset to prevent stale state.

## Consequences

### Positive

- Fast typists can queue messages during a tool chain instead of having them lost or interleaved
- Soft cancel via `/cancel` or ESC lets users stop a runaway tool chain without killing the agent
- The conversation loop remains single-threaded — no concurrency issues
- The readline mode (`interactive.ts`) needed no changes — it already blocks on user input
- 4 new tests cover queue drain, cancel sentinel, cancel preserves queue, and clearSession flush

### Negative

- Queued messages are not visible to the LLM until the next loop boundary — there's a delay between typing and the LLM seeing the message
- The `CANCEL_SENTINEL` return value requires callers to check for it (the TUI does, but embedding code via `lib.ts` needs to be aware)
- Read-only slash commands are unnecessarily blocked during LLM activity (acceptable for simplicity)

## Related

- tool-call-loop — Loop order with drain and cancel steps
- session-management — Session lifecycle
- [Session](../../drone-core/src/session-types.ts) — Session types
- [023-conversation-event-push-through](023-conversation-event-push-through.md) — Event push-through design

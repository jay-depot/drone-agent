---
key: tighten-conversation-loop
tags:
  - plan
  - conversation-loop
  - concurrency
created: 2026-07-02T02:22:38.820Z
updated: 2026-07-02T02:40:00.627Z
---

# Plan: Tighten Conversation Loop with Predictable Concurrency

## Summary

Add a message queue and soft-cancel mechanism to the `ConversationService` so that user messages typed while the LLM is processing get queued and drained at a safe loop boundary (the top of the `while(true)` loop, after the previous tool round's results are appended and hooks have run). Add a `/cancel` command (and repurpose ESC) for soft cancellation. The TUI routes input to either `sendUserMessage` (idle) or `enqueueUserMessage` (busy).

## Motivation

The TUI currently calls `sendUserMessage` via `void runSlashCommand(value)` — fire-and-forget. A fast typist can start a second `sendUserMessage` while the first is still in a tool chain, causing both invocations to share and interleave mutations on `sessionManager.turns[]`. The readline mode (`interactive.ts`) is safe because it blocks on `await rl.question(...)`. This plan brings the TUI to parity by queuing messages and draining them at a predictable boundary.

## Architecture

```
TUI onSubmit(value):
  ├─ if isLlmActive AND is a plain message:
  │     conversation.enqueueUserMessage(value)   // queue it
  │     log "> value"
  │     return
  │
  ├─ if isLlmActive AND value == "/cancel":
  │     conversation.cancelCurrentRequest()
  │     log "Cancelled"
  │     return
  │
  └─ else:
        runSlashCommand(value)   // normal path → sendUserMessage

sendUserMessage(prompt):
  drain any leftover queue (from previous cancel)
  appendUserMessage(prompt)       // new turn
  while(true):
    if cancelled flag:
      cancelled = false
      return CANCEL_SENTINEL
    drain pending queue → appendUserMessage per msg
    (budget key check, system messages, safety check, LLM call, tool chain, hooks...)
    continue
```

The drain point is the **top of the while(true) loop** — after the budget key cache check, but before building system messages. This means:
- Messages queued during a tool chain appear as new user turns in the LLM's view of conversation
- They're appended at a consistent moment: after the previous LLM round's tool results are in the session and all `onAfterToolCall` hooks have run
- The LLM sees the full context (completed tool results + new user message) on the next call

## Key Design Decisions

- **ESC no longer exits.** It cancels the current request if the LLM is active, otherwise it's a no-op. `Ctrl-C` (and `Ctrl-C` twice for emergencies) remains the only keyboard exit.
- **Cancel preserves the queue.** Messages queued before a `/cancel` survive and are drained on the next `sendUserMessage` call.
- **Slash commands that touch session/LLM state** (like `/clear`, `/exec`, `/tool`) and `/cancel` are *not* enqueued — `/cancel` fires immediately, and others are blocked by the TUI's routing logic (they can only be submitted when `isLlmActive` is false). Read-only slash commands (`/help`, `/plugins`, `/tools`, `/systemprompt`) could in theory be allowed while active, but for simplicity the first pass treats *all* slash commands as "must wait for LLM" (since `/cancel` is the only one that makes sense during activity).

## Completion Summary

Implemented 2026-07-02. All 10 steps completed:

1. **conversation-service.ts** — Added `CANCEL_SENTINEL` export, `pendingMessages[]` queue, `cancelled` flag, `enqueueUserMessage()`, `cancelCurrentRequest()`, drain at top of `while(true)` loop and at start of `sendUserMessage`, queue flush on `clearSession()`.
2. **lib.ts** — Exported `CANCEL_SENTINEL`.
3. **tui/app.tsx** — Input routing: when `isLlmActive`, `/cancel` fires immediately, all other input is enqueued; normal path unchanged.
4. **tui/app.tsx** — ESC cancels when LLM is active, no-op when idle; help text updated to reflect new keybindings; `Ctrl-C` remains the only keyboard exit.
5. **plugin-system.ts** — Added `enqueueUserMessage?` and `cancelCurrentRequest?` to `DroneSlashCommandContext.conversation` type.
6. **tui/types.ts** — Added `enqueueUserMessage?` and `cancelCurrentRequest?` to `DroneTuiOptions.conversation` type.
7. **interactive.ts** — Verified no changes needed (readline mode blocks on user input, type extension handles the rest).
8. **conversation-service.test.ts** — 4 new tests: queue drain, cancel sentinel, cancel preserves queue, clearSession flushes queue.
9. **tui.test.tsx** — Updated mock to include new optional methods.
10. **llm-provider-switching.test.ts** — Fixed pre-existing LSP type errors (spread of optional `conversation?` fields causing `getModel` to become `| undefined`), added new methods.

**Validation:** `pnpm typecheck` passes cleanly; `pnpm test` passes 854/854 tests (49 files); lint errors are pre-existing in `drone-swarm-common/src/tls.ts` (no changes to that file).
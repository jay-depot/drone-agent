---
key: macro-ui-feedback-plan
tags:
  - plan
  - macros
  - ui
  - feedback
created: 2026-06-27T20:46:42.094Z
updated: 2026-06-27T21:01:53.668Z
---

# Plan: Fix Macro UI Feedback (Chat Prompt Display, LLM Indicator, Event Streaming)

## Summary

When a macro has a `chatPrompt` step, three things are broken:
1. The substituted prompt text is not displayed in the TUI chat log
2. The LLM working indicator (spinning `○◎◉●`) does not activate
3. Reasoning, tool calls, and tool results from the macro-triggered LLM call are not displayed

## Root Cause

The macro's `executeMacro()` calls `ctx.conversation.sendUserMessage(substituted)` **without an `onEvent` callback**. The `ConversationEvent` emissions (reasoning, toolCall, toolResult, assistantMessage) are emitted by `conversation-service.ts` via its internal `emit()` function, but since no `onEvent` was passed, they go nowhere. The TUI's event handler that renders them lives only in the default "send to chat" path in `app.tsx`, which is never reached when a slash command is handled.

The `interactive.ts` (non-TUI) path has the same problem — it dispatches the slash command and continues, never processing events from the macro's `sendUserMessage`.

## Step-by-Step Plan

### Step 1: Pass an `onEvent` callback in `executeMacro`

**File:** `drone-agent/src/plugins/macros/index.ts`

In the `chatPrompt` branch, pass an `onEvent` callback to `sendUserMessage` that maps `ConversationEvent` fields to `ctx.logger` calls. Since the event type is `unknown` from the plugin's perspective (it's defined in `conversation-service.ts`, not `drone-core`), use a type guard to check the `kind` property.

### Step 2: Map `info` to `'user'` kind in TUI slash command logger

**File:** `drone-agent/src/tui/app.tsx`

Change the slash command dispatch logger so `info` maps to `'user'` kind (instead of `'plain'`). This makes the macro's logged prompt and events appear as user/assistant messages with correct styling.

### Step 3: Activate LLM indicator during slash command dispatch

**File:** `drone-agent/src/tui/app.tsx`

Wrap the `dispatchSlashCommand` call in `setIsLlmActive(true/false)` so the indicator activates when a macro makes LLM calls.

### Step 4: Add tests

**File:** `drone-agent/test/macros.test.ts`

Add a test that creates a macro with a `chatPrompt` step, dispatches it, and verifies:
- The substituted text appears in the logger's `info` calls
- The `onEvent` callback is exercised (reasoning/toolCall/toolResult events are logged)

## Validation Criteria

- All existing tests pass (`pnpm test`)
- No LSP errors
- A macro with a `chatPrompt` step displays the substituted text in the TUI
- Reasoning, tool calls, and tool results from the macro-triggered LLM call appear in the TUI
- The LLM working indicator (spinning `○◎◉●`) activates during macro execution

## Work Completed (2026-06-27)

All four steps implemented and committed in `5b51a3a`:
- **Step 1**: Added `onEvent` callback in `executeMacro` that maps `reasoning`, `toolCall`, `toolResult`, `assistantMessage`, and `error` events to `ctx.logger` calls. Also logs the substituted prompt text before sending.
- **Step 2**: Changed `info: msg => log(msg, 'plain')` to `info: msg => log(msg, 'user')` in the TUI's slash command dispatch logger.
- **Step 3**: Wrapped `dispatchSlashCommand` in `setIsLlmActive(true/false)` with try/finally.
- **Step 4**: Added test `'logs chatPrompt text and streams events from sendUserMessage'` that verifies all event types are logged via the callback.
- All 498 tests pass across 34 test files.

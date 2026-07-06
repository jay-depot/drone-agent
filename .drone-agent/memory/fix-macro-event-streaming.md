---
key: fix-macro-event-streaming
tags:
  - plan
  - fix
  - macros
  - tui
  - conversation-service
  - completed
created: 2026-07-06T19:12:35.450Z
updated: 2026-07-06T19:28:07.946Z
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

## Files Modified

### 1. `drone-agent/src/runtime/plugin-engine.ts`

**Change:** Added `onConversationEvent` to the public `DronePluginEngine` type with unsubscribe support. Added `externalConversationEventListeners` array alongside the existing `conversationEventHooks`. The `runConversationEventHooks` method now notifies both internal plugin hooks and external listeners.

### 2. `drone-agent/src/tui/types.ts`

**Change:** Added `onConversationEvent` to the engine handle in `DroneTuiOptions`.

### 3. `drone-agent/src/tui/app.tsx`

**Change A:** Registered a conversation event listener on mount that logs events with proper `ChatEntry` kinds (reasoning → `'reasoning'`, toolCall → `'toolCall'`, etc.).

**Change B:** Wrapped `dispatchSlashCommand` in `setIsLlmActive(true/false)` to restore the thinking indicator during macro execution.

**Change C:** Removed the `onEvent` callback from the regular message path's `sendUserMessage` call — the engine hook listener now handles it.

### 4. `drone-agent/src/plugins/macros/index.ts`

**Change:** Removed the `onEvent` callback from the `sendUserMessage` call. Events still fire through engine conversation event hooks.

### 5. `drone-agent/src/interactive.ts`

**Change:** Added `onConversationEvent` to the engine handle for type consistency.

### 6. `drone-core/src/plugin-system.ts`

**Change:** Added `onConversationEvent` to the `DroneSlashCommandContext.engine` type.

### 7. Test files

**Change:** Updated mocks in `tui.test.tsx`, `tui-persona-color.test.tsx`, `systemprompt.test.tsx`, `conversation-service.test.ts`, `persona-tool-call-limit.test.ts`, and `helpers.ts` to include `onConversationEvent`. Updated `macros.test.ts` to verify events through engine hooks instead of the `onEvent` callback.

## Validation

- `pnpm typecheck` — clean (only pre-existing errors in `swarm-spawn.test.ts`)
- `pnpm build` — all packages compile
- `pnpm test` — 1209/1209 tests pass across 64 test files

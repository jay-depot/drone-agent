---
key: tui-tail-region-refactor
tags:
  - tui
  - refactor
  - plan
  - tail-region
  - complete
created: 2026-07-06T19:49:05.879Z
updated: 2026-07-06T20:17:26.136Z
---

# TUI Tail Region Refactor: Live Pre-Rendering with Atomic Commit

## Summary

Refactored the drone-agent TUI to introduce a **tail region** — a live-updating area between the `<Static>` scrollback and the input line — where all in-flight content (reasoning, tool calls, assistant messages) is pre-rendered as live React components before being atomically committed to the scrollback.

**Status: COMPLETE** — All 10 steps implemented, committed as `90bd6fa`.

## What Was Built

### New Event Kinds (drone-core)
- `reasoningComplete` — signals end of a reasoning block
- `assistantMessageComplete` — signals message is done
- `toolCallBatch` — batch start with all tool call metadata
- `toolResultBatch` — batch complete with all results

### Parallel Tool Execution (drone-agent)
- Tool calls now execute via `Promise.all` instead of a serial `for` loop
- Stuck detector still works: checks all results after batch completes
- Session appends remain in original order
- `onAfterToolCall` hooks still run once after the batch

### New Tail Components (drone-agent)
- `TailRegion` — renders live-updating items above `<Static>`
- `ToolCallProgress` — live tool call with spinner, result preview, error state
- `ReasoningBlock` — live reasoning text, properly colored
- `AssistantMessageBlock` — live assistant message

### useTailRegion Hook
- `addItem(kind, component, toEntry)` → returns id
- `updateItem(id, component, toEntry)` → updates live component
- `commitItem(id)` → returns `Omit<ChatEntry, 'id'>` for atomic commit
- `commitAll()` → commits all items
- `clear()` → removes all items without committing

### Refactored app.tsx
- Conversation event listener uses tail region for all in-flight content
- Nothing logged to `<Static>` until `*Complete` event fires
- Scheme ref used to avoid stale closure in event listener
- `appendEntry` used for committing tail items (handles id generation)

### Color Wrap Fix
- Each tail component wraps content in single `<Text color={...} wrap="wrap">`
- Ink applies color to all soft-wrapped continuation lines

### Non-TUI Handlers Updated
- `output-handlers.ts`: plain handler flattens batch events
- `interactive.ts`: NDJSON handlers flatten `toolCallBatch`/`toolResultBatch`

### Tests Added
- `conversation-service-events.test.ts`: 4 new tests for batch events, parallel execution, reasoningComplete, assistantMessageComplete
- Updated existing test in `conversation-service.test.ts` to check for `toolCallBatch`/`toolResultBatch`

## Validation

- **Build**: `pnpm build` exits with code 0
- **Lint**: `pnpm lint` exits with code 0
- **Tests**: 65 test files, 1213 tests, all passing
- **Parallel execution**: Test verifies that tool calls with 100ms/10ms delays complete in <150ms (not ~110ms)
---
tags: [decision, tui, conversation, events]
related:
  [
    023-conversation-event-push-through.md,
    036-ink-6-react-19.md,
    037-incremental-rendering-removal.md,
    045-macro-event-streaming-unified-hooks.md,
    flows/tool-call-loop.md,
    modules/drone-agent-tui.md,
    entities/Session.md,
  ]
---

# ADR 046: TUI Tail Region — Live Pre-Rendering with Atomic Commit

**Status**: Implemented (commit `90bd6fa`, 2026-07-06)

## Context

The drone-agent TUI previously rendered in-flight content (reasoning, tool calls, assistant messages) directly to the `<Static>` scrollback via `log()`. This had two problems:

1. **Soft-wrap color bug**: When Ink's `<Text>` component wraps a line, the `color` prop only applies to the first line. Wrapped continuation lines appear in the default terminal color, making colored content (tool calls, reasoning) look broken.

2. **Serial tool execution**: The conversation service executed tool calls in a serial `for` loop because each tool call emitted `toolCall` and `toolResult` events individually, and the TUI logged them incrementally. Parallel execution would cause interleaved output.

## Decision

Introduce a **tail region** — a live-updating area between the `<Static>` scrollback and the mid panel — where all in-flight content is pre-rendered as live React components before being atomically committed to the scrollback.

### New Event Kinds

Four new `DroneConversationEvent` kinds were added to `drone-core/src/session-types.ts`:

- `reasoningComplete` — signals end of a reasoning block
- `assistantMessageComplete` — signals the assistant message is done
- `toolCallBatch` — batch start with all tool call metadata
- `toolResultBatch` — batch complete with all results

### Parallel Tool Execution

The conversation service's tool-call loop was changed from a serial `for` loop to `Promise.all`:

```typescript
const rawResults = await Promise.all(
  toolCalls.map(toolCall =>
    executeToolSafely(toolCall.name, toolCall.arguments).then(toolResult => ({
      name,
      toolResult,
      toolCallId,
    }))
  )
);
```

- The stuck detector still works: it checks all results after the batch completes
- Session appends remain in original order (the map preserves array order)
- `onAfterToolCall` hooks still run once after the batch

### New Tail Components

| Component               | File                                   | Purpose                                                   |
| ----------------------- | -------------------------------------- | --------------------------------------------------------- |
| `TailRegion`            | `components/TailRegion.tsx`            | Renders live-updating items above `<Static>`              |
| `ToolCallProgress`      | `components/ToolCallProgress.tsx`      | Live tool call with status indicator (running/done/error) |
| `ReasoningBlock`        | `components/ReasoningBlock.tsx`        | Live reasoning text with proper coloring                  |
| `AssistantMessageBlock` | `components/AssistantMessageBlock.tsx` | Live assistant message                                    |

### useTailRegion Hook

Located in `hooks/useTailRegion.ts`. Manages a set of live `TailItem` objects:

- `addItem(kind, component, toEntry)` → returns a stable id
- `updateItem(id, component, toEntry)` → updates the live component and entry function
- `commitItem(id)` → removes from tail, returns `Omit<ChatEntry, 'id'>` for atomic commit
- `commitAll()` → commits all items
- `clear()` → removes all items without committing (for error recovery)

Each item has a stable `id` (React key), a `kind` (reasoning/toolCall/assistantMessage), a `component` (live React element), and a `toEntry()` function that produces the `ChatEntry` data when committed.

### Refactored app.tsx

The conversation event listener was rewritten to use the tail region:

- **Reasoning events**: Accumulate in the tail. On `reasoningComplete`, commit to `<Static>`.
- **Tool calls**: `toolCallBatch` creates one `TailItem` per tool call. `toolResultBatch` updates each with result/error status and commits all.
- **Assistant messages**: `assistantMessage` streams in the tail. `assistantMessageComplete` commits.
- **Errors**: Clear all in-flight tail items, then log the error message.

A `schemeRef` is used to avoid stale closure in the event listener, since the color scheme is managed by a separate hook.

### Color Wrap Fix

Each tail component wraps its entire content in a single `<Text color={...} wrap="wrap">` element. This ensures Ink applies the color to every soft-wrapped continuation line, not just the first line.

### Non-TUI Handlers Updated

- `output-handlers.ts`: Plain output handler flattens `toolCallBatch`/`toolResultBatch` into individual events
- `interactive.ts`: Both JSON mode and JSON listen mode flatten batch events for NDJSON backward compatibility
- Complete markers (`reasoningComplete`, `assistantMessageComplete`) are silently ignored by non-TUI handlers

### ChatLog Component

The `ChatLog` component now accepts `tailItems: TailItem[]` instead of a single `tail?: ReactNode`. The `TailRegion` is rendered above the `<Static>` scrollback.

## Consequences

### Positive

- **Color wrap fix**: All tail content renders with correct colors across soft-wrapped lines
- **Parallel tool execution**: Tool calls execute concurrently, reducing total latency
- **Smooth visual updates**: Live components update in real-time without jank
- **Atomic commit**: Content appears in the scrollback only when complete, preventing visual noise
- **Error recovery**: Errors clear the tail region cleanly

### Negative

- **Increased complexity**: The tail region adds a new rendering layer (hook + components + event handling)
- **State tracking**: The `app.tsx` event listener must track `currentReasoningId`, `currentToolCallIds`, and `currentMessageId` refs across events
- **Scheme ref pattern**: The `schemeRef` pattern is a workaround for stale closures in event listeners

### Testing

4 new tests in `conversation-service-events.test.ts`:

- Batch event emission (toolCallBatch + toolResultBatch)
- Parallel execution (verifies 100ms/10ms tools complete in <150ms)
- reasoningComplete emission
- assistantMessageComplete emission

Existing test in `conversation-service.test.ts` updated to check for `toolCallBatch`/`toolResultBatch` instead of individual `toolCall`.

## Related

- [023-conversation-event-push-through](023-conversation-event-push-through.md) — Original conversation event system
- [036-ink-6-react-19](036-ink-6-react-19.md) — Ink 6 upgrade (tail components use `<Text wrap="wrap">`)
- [037-incremental-rendering-removal](037-incremental-rendering-removal.md) — Tail region uses standard full-redraw mode
- [045-macro-event-streaming-unified-hooks](045-macro-event-streaming-unified-hooks.md) — Unified event hook system (tail region listens via `onConversationEvent`)

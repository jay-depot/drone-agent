---
key: tui-tail-region-refactor
tags:
  - tui
  - refactor
  - plan
  - tail-region
created: 2026-07-06T19:49:05.879Z
updated: 2026-07-06T19:49:05.879Z
---

# TUI Tail Region Refactor: Live Pre-Rendering with Atomic Commit

## Summary

Refactor the drone-agent TUI to introduce a **tail region** — a live-updating area between the `<Static>` scrollback and the input line — where all in-flight content (reasoning, tool calls, assistant messages) is pre-rendered as live React components before being atomically committed to the scrollback. This enables:

1. **True parallel tool execution** — each tool call gets its own live component; they run concurrently and commit as a batch
2. **Proper color wrapping** — entire tool call blocks are wrapped in `<Text color={...}>`, fixing the soft-wrap color reset
3. **Smoother visual experience** — no flickering as individual events are appended to `<Static>` one at a time
4. **Extensible architecture** — plugins can register custom tail components for long-running background tasks

## Current Architecture (Problems)

### Problem 1: Serial Tool Execution

In `conversation-service.ts` (lines ~310-340), tool calls are executed in a serial `for` loop:

```ts
for (const toolCall of response.toolCalls) {
  emit({ kind: 'toolCall', name: toolCall.name, arguments: toolCall.arguments });
  const toolResult = await executeToolSafely(toolCall.name, toolCall.arguments);
  emit({ kind: 'toolResult', name: toolCall.name, content: toolResult.content, arguments: toolCall.arguments });
  // ... append to session ...
}
```

Each `emit()` fires the `onEvent` callback, which in `app.tsx` immediately calls `log(...)`, which appends to the `entries` array — rendered inside `<Static>`. So every tool call event is immediately committed to the scrollback before the next tool call starts. Parallel execution would interleave output chaotically.

### Problem 2: Color Wrap Bug

In `app.tsx`, tool call entries are logged as single strings with a color prefix:

```tsx
log(`→ tool: ${event.name} ${argsPreview}`, 'toolCall');
```

The `renderEntry` function in `ChatLog.tsx` wraps the entire text in a `<ColorTag color={scheme.toolCall}>` — but this only applies color to the first line. When Ink soft-wraps the text, subsequent lines revert to the default terminal color because Ink applies color per-line, and the wrapped continuation lines are not part of the styled `<Text>` element's visible span.

### Problem 3: No Plugin Extensibility

The `DroneTuiCapability` type is defined in `types.ts` but never offered as a runtime capability. Mid-panel widgets are discovered via a hardcoded list. Color overrides are only wired for persona. There's no way for a plugin to register a custom tail component.

## Target Architecture

```
┌──────────────────────────────────────┐
│ <Static> scrollback                 │  ← Committed entries only
│   [past reasoning blocks]            │
│   [past tool calls]                 │
│   [past assistant messages]         │
│                                      │
├──────────────────────────────────────┤
│ TAIL REGION (live, re-renders)      │  ← NEW: in-flight content
│   [reasoning block - streaming]     │
│   [tool call 1: git diff ...]       │  ← live progress
│   [tool call 2: file write ...]     │  ← live progress
│   [tool call 3: exec run ...]       │  ← live progress
│                                      │
├──────────────────────────────────────┤
│ Mid panel (widgets)                 │
├──────────────────────────────────────┤
│ Input line                           │
├──────────────────────────────────────┤
│ Status bar                           │
└──────────────────────────────────────┘
```

### Data Flow

```
LLM returns toolCalls (parallel batch)
    │
    ▼
conversation-service emits 'toolCallBatch' event
    │
    ▼
app.tsx creates TailItem for each tool call
    │
    ▼
All tool calls execute in parallel via Promise.all
    │
    ▼
Each TailItem updates independently as its result arrives
    │
    ▼
When ALL tool calls in the batch complete:
    ├─→ conversation-service emits 'toolResultBatch' event
    ├─→ app.tsx commits all TailItems to <Static> as a single batch
    └─→ TailItems are removed from the tail region
```

## Step-by-Step Implementation Plan

### Step 1: Extend `DroneConversationEvent` with batch events

**File:** `drone-core/src/session-types.ts`

Add new event kinds to the `DroneConversationEvent` discriminated union:

```ts
export type DroneConversationEvent =
  | { kind: 'userMessage'; content: string }
  | { kind: 'reasoning'; content: string }
  | { kind: 'reasoningComplete' }  // NEW: signals end of a reasoning block
  | { kind: 'assistantMessage'; content: string }
  | { kind: 'assistantMessageComplete' }  // NEW: signals message is done
  | { kind: 'toolCallBatch'; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> }  // NEW: batch start
  | { kind: 'toolCall'; name: string; arguments: Record<string, unknown> }
  | { kind: 'toolResult'; name: string; content: string; arguments: Record<string, unknown> }
  | { kind: 'toolResultBatch'; results: Array<{ name: string; content: string; arguments: Record<string, unknown> }> }  // NEW: batch complete
  | { kind: 'error'; message: string };
```

**Validation:** Re-export from `drone-core/src/index.ts`. Update any consumers that pattern-match on `DroneConversationEvent` to handle the new kinds (they can ignore them).

### Step 2: Refactor conversation service for parallel tool execution

**File:** `drone-agent/src/runtime/conversation-service.ts`

Replace the serial `for` loop with parallel execution:

```ts
// Before (serial):
for (const toolCall of response.toolCalls) {
  emit({ kind: 'toolCall', name: toolCall.name, arguments: toolCall.arguments });
  const toolResult = await executeToolSafely(toolCall.name, toolCall.arguments);
  // ... emit toolResult, append to session ...
}

// After (parallel):
emit({
  kind: 'toolCallBatch',
  toolCalls: response.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })),
});

const results = await Promise.all(
  response.toolCalls.map(async toolCall => {
    const toolResult = await executeToolSafely(toolCall.name, toolCall.arguments);
    return { name: toolCall.name, content: toolResult.content, arguments: toolCall.arguments, toolCallId: toolCall.id };
  })
);

emit({
  kind: 'toolResultBatch',
  results: results.map(r => ({ name: r.name, content: r.content, arguments: r.arguments })),
});

// Append all results to session (still in order for session consistency)
for (const result of results) {
  sessionManager.appendToolResult(result.name, result.content, result.toolCallId);
}
```

**Key design decisions:**
- The `toolCallBatch` event fires once with all tool call metadata, so the TUI can create one TailItem per tool call
- The `toolResultBatch` event fires once with all results, so the TUI can commit them atomically
- Session appends remain in order (the `results` array preserves the original tool call order)
- The stuck-error detector still works — it checks all results after the batch completes
- The `onAfterToolCall` hook still runs once after the batch

**Also emit `reasoningComplete` after the reasoning block ends** (when `response.reasoning` is present and the next thing is tool calls or an assistant message).

**Also emit `assistantMessageComplete`** when the final assistant message is returned (before the `return` statement).

### Step 3: Create TailItem types and components

**File:** `drone-agent/src/tui/types.ts`

Add tail item types:

```ts
/** A single item in the tail region — a live-updating component. */
export type TailItem = {
  id: string;
  kind: 'reasoning' | 'toolCall' | 'assistantMessage';
  /** The live component to render. Re-renders on every state change. */
  component: React.ReactNode;
  /** Called when this item should be committed to <Static>. Returns the ChatEntry to append. */
  toEntry: () => ChatEntry;
};
```

**New file:** `drone-agent/src/tui/components/TailRegion.tsx`

```tsx
/**
 * Tail region — renders live-updating components above the <Static> scrollback.
 * Each TailItem is a React component that re-renders as its state changes.
 * When an item is "done", it's removed from the tail and committed to <Static>.
 */
export function TailRegion({
  items,
  scheme,
}: {
  items: TailItem[];
  scheme: DroneColorScheme;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {items.map(item => (
        <Box key={item.id} flexDirection="column">
          {item.component}
        </Box>
      ))}
    </Box>
  );
}
```

**New file:** `drone-agent/src/tui/components/ToolCallProgress.tsx`

```tsx
/**
 * Live-updating tool call component for the tail region.
 * Shows the tool name, arguments, and a spinner while executing.
 * When the result arrives, shows the result preview.
 * The entire block is wrapped in a single <Text color={scheme.toolCall}>,
 * fixing the soft-wrap color bug.
 */
export function ToolCallProgress({
  name,
  args,
  result,
  status, // 'running' | 'done' | 'error'
  scheme,
}: {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: 'running' | 'done' | 'error';
  scheme: DroneColorScheme;
}): React.JSX.Element {
  const color = status === 'error' ? scheme.error
    : status === 'done' ? scheme.toolResult
    : scheme.toolCall;

  const spinner = status === 'running' ? '…' : status === 'error' ? '✗' : '✓';
  const argsPreview = preview(JSON.stringify(args), 200);

  return (
    <Text color={color} wrap="wrap">
      {`${spinner} ${name}(${argsPreview})`}
      {result ? `\n${preview(result, 500)}` : ''}
    </Text>
  );
}
```

**New file:** `drone-agent/src/tui/components/ReasoningBlock.tsx`

```tsx
/**
 * Live-updating reasoning block for the tail region.
 * Shows reasoning text as it streams in, wrapped in a single
 * <Text color={scheme.reasoning}> for proper color wrapping.
 */
export function ReasoningBlock({
  content,
  scheme,
}: {
  content: string;
  scheme: DroneColorScheme;
}): React.JSX.Element {
  return (
    <Text color={scheme.reasoning} wrap="wrap">
      {`💭 ${content}`}
    </Text>
  );
}
```

### Step 4: Create `useTailRegion` hook

**New file:** `drone-agent/src/tui/hooks/useTailRegion.ts`

```ts
/**
 * Hook for managing the tail region — a set of live-updating items
 * that get committed to <Static> when they complete.
 *
 * Provides:
 * - `items`: the current set of live TailItems
 * - `addItem(item)`: add a new live item
 * - `updateItem(id, partial)`: update an existing item's state
 * - `commitItem(id)`: remove from tail and return a ChatEntry for <Static>
 * - `commitAll()`: commit all items and return ChatEntry[]
 */
export function useTailRegion(): {
  items: TailItem[];
  addItem: (item: Omit<TailItem, 'id'> & { id?: string }) => string;
  updateItem: (id: string, update: Partial<Pick<TailItem, 'component' | 'toEntry'>>) => void;
  commitItem: (id: string) => ChatEntry;
  commitAll: () => ChatEntry[];
  clear: () => void;
} {
  // ... implementation using useRef + useState
}
```

### Step 5: Wire tail region into ChatLog

**File:** `drone-agent/src/tui/components/ChatLog.tsx`

The `tail` prop already exists. Update the component to accept `TailItem[]` instead of a raw `ReactNode`:

```tsx
export function ChatLog({
  entries,
  tailItems,  // was: tail?: ReactNode
  scheme,
}: {
  entries: ChatEntry[];
  tailItems: TailItem[];
  scheme: DroneColorScheme;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      <TailRegion items={tailItems} scheme={scheme} />
      <Static items={entries} style={{ width: '100%' }}>
        {entry => (
          <Box key={entry.id} flexDirection="column">
            {renderEntry(entry, scheme)}
          </Box>
        )}
      </Static>
    </Box>
  );
}
```

### Step 6: Refactor app.tsx to use tail region

**File:** `drone-agent/src/tui/app.tsx`

This is the largest change. The conversation event listener needs to be rewritten to:

1. On `reasoning` → create a `ReasoningBlock` in the tail, or append to the existing one
2. On `reasoningComplete` → commit the reasoning block to `<Static>`
3. On `toolCallBatch` → create a `ToolCallProgress` for each tool call in the tail
4. On `toolResultBatch` → update each `ToolCallProgress` with its result, then commit all of them to `<Static>`
5. On `assistantMessage` → create an `AssistantMessageBlock` in the tail
6. On `assistantMessageComplete` → commit the message to `<Static>`
7. On `error` → commit immediately as an error entry

The key insight: **nothing gets logged to `entries` until a `*Complete` event fires**. All intermediate state lives in the tail.

```tsx
// In App:
const { items: tailItems, addItem, updateItem, commitAll, clear: clearTail } = useTailRegion();
let currentReasoningId: string | null = null;
let currentToolCallIds: string[] = [];
let currentMessageId: string | null = null;

useEffect(() => {
  const unregister = opts.engine.onConversationEvent?.(event => {
    switch (event.kind) {
      case 'reasoning': {
        if (!currentReasoningId) {
          currentReasoningId = addItem({
            kind: 'reasoning',
            component: <ReasoningBlock content={event.content} scheme={scheme} />,
            toEntry: () => ({ text: event.content, kind: 'reasoning' }),
          });
        } else {
          // Append to existing reasoning block
          updateItem(currentReasoningId, {
            component: <ReasoningBlock content={/* accumulated */} scheme={scheme} />,
            toEntry: () => ({ text: /* accumulated */, kind: 'reasoning' }),
          });
        }
        break;
      }
      case 'reasoningComplete': {
        if (currentReasoningId) {
          const entry = commitItem(currentReasoningId);
          log(entry.text, entry.kind);
          currentReasoningId = null;
        }
        break;
      }
      case 'toolCallBatch': {
        currentToolCallIds = event.toolCalls.map(tc => {
          return addItem({
            kind: 'toolCall',
            component: <ToolCallProgress name={tc.name} args={tc.arguments} status="running" scheme={scheme} />,
            toEntry: () => ({ text: `→ ${tc.name}(${preview(JSON.stringify(tc.arguments), 200)})`, kind: 'toolCall' }),
          });
        });
        break;
      }
      case 'toolResultBatch': {
        // Update each tool call with its result
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const id = currentToolCallIds[i];
          if (id) {
            updateItem(id, {
              component: <ToolCallProgress name={result.name} args={result.arguments} result={result.content} status="done" scheme={scheme} />,
              toEntry: () => ({ text: `→ ${result.name}: ${preview(result.content, 500)}`, kind: 'toolResult' }),
            });
          }
        }
        // Commit all tool calls as a batch
        const entries = currentToolCallIds.map(id => commitItem(id));
        for (const entry of entries) {
          log(entry.text, entry.kind);
        }
        currentToolCallIds = [];
        break;
      }
      // ... similar for assistantMessage / assistantMessageComplete
    }
  });
  return () => unregister?.();
}, [opts.engine, log, scheme, addItem, updateItem, commitItem]);
```

**Important:** The `scheme` reference in the closure needs to be stable. Since `scheme` changes when color overrides cycle, the tail components should read the current scheme from a ref or context rather than capturing it in the closure. Use a `useRef` for the scheme and pass it through context.

### Step 7: Fix the color wrap bug

The fix is inherent in the new architecture — each tail component wraps its entire content in a single `<Text color={...}>` element. Ink applies the color to the entire text node, including soft-wrapped continuation lines.

**No additional work needed** beyond what Steps 3-6 already do. The `ToolCallProgress` and `ReasoningBlock` components use `<Text color={...} wrap="wrap">` which correctly colors all wrapped lines.

### Step 8: Update non-TUI output handlers

**File:** `drone-agent/src/output-handlers.ts`

The `makePlainOutputEventHandler` and `makeNdjsonOutputEventHandler` need to handle the new event kinds. For plain output, `toolCallBatch` and `toolResultBatch` should produce the same output as individual events (just batched). For NDJSON, emit individual events for each tool call/result within the batch.

**File:** `drone-agent/src/interactive.ts`

The `runJsonMode` and `runJsonListenMode` functions pattern-match on `ConversationEvent` — add cases for the new event kinds (they can flatten batches into individual events for backward compatibility with the NDJSON protocol).

### Step 9: Update tests

**File:** `drone-agent/test/conversation-service.test.ts`

- Add tests for parallel tool execution
- Verify that `toolCallBatch` and `toolResultBatch` events are emitted
- Verify that session appends remain in order
- Verify that the stuck-error detector still works with parallel execution

**New file:** `drone-agent/test/tui-tail-region.test.ts`

- Test `useTailRegion` hook: add, update, commit, commitAll
- Test `ToolCallProgress` component renders correctly in all states
- Test `ReasoningBlock` component
- Test that tail items are properly committed to entries

**File:** `drone-agent/test/output-handlers.test.ts` (or update existing)

- Test that new event kinds are handled by plain and NDJSON handlers

### Step 10: Verify LSP and linting

Run `pnpm typecheck` and `pnpm lint` to ensure no regressions. Fix any issues.

## Validation Criteria

1. **All LSP checks pass** — `pnpm typecheck` exits with code 0
2. **All linting passes** — `pnpm lint` exits with code 0
3. **All tests pass** — `pnpm test` exits with code 0
4. **Parallel tool execution works** — When the LLM returns multiple tool calls, they execute concurrently (verified by test: tool calls with artificial delays complete in less than the sum of their individual delays)
5. **Tail region renders correctly** — In-flight content appears in the tail region, not in `<Static>`
6. **Atomic commit works** — Completed content appears in `<Static>` as a single entry, not as individual event lines
7. **Color wrap is fixed** — Multi-line tool call output has consistent color across soft-wrapped lines (verified by visual inspection in the TUI)
8. **Backward compatibility** — Plain output mode and NDJSON mode still produce correct output with the new event kinds
9. **No regressions in existing functionality** — All existing tests pass, and manual smoke test of the TUI shows no visual regressions

## Dependencies

- Step 1 must be done before Step 2 (new event types needed)
- Step 2 must be done before Step 8 (event producers before consumers)
- Steps 3-4 must be done before Step 5 (components before wiring)
- Step 5 must be done before Step 6 (ChatLog changes before App changes)
- Step 6 must be done before Step 9 (implementation before tests)
- Step 8 can be done in parallel with Steps 3-6
- Step 9 can be done after Steps 1-8
- Step 10 is the final validation step

## Order of Execution

1. Step 1: Extend `DroneConversationEvent` (drone-core)
2. Step 2: Refactor conversation service for parallel execution (drone-agent)
3. Step 3: Create TailItem types and components (drone-agent)
4. Step 4: Create `useTailRegion` hook (drone-agent)
5. Step 5: Wire tail region into ChatLog (drone-agent)
6. Step 6: Refactor app.tsx to use tail region (drone-agent)
7. Step 7: Color wrap fix (inherent in Steps 3-6)
8. Step 8: Update non-TUI output handlers (drone-agent)
9. Step 9: Write tests (drone-agent)
10. Step 10: Verify LSP and linting

---
key: tighten-conversation-loop
tags:
  - plan
  - conversation-loop
  - concurrency
created: 2026-07-02T02:22:38.820Z
updated: 2026-07-02T02:24:26.934Z
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

## Step-by-Step Implementation

### Step 1: Add `enqueueUserMessage`, `cancelCurrentRequest`, and CANCEL_SENTINEL

**File:** `drone-agent/src/runtime/conversation-service.ts`

**Changes:**

1. Export a sentinel constant:
   ```typescript
   export const CANCEL_SENTINEL = '__CANCELLED__';
   ```

2. Add to the `ConversationService` type:
   ```typescript
   enqueueUserMessage: (prompt: string) => void;
   cancelCurrentRequest: () => void;
   ```

3. Inside `createConversationService`, add closure state:
   ```typescript
   const pendingMessages: string[] = [];
   let cancelled = false;
   ```

4. At the start of `sendUserMessage`, drain any leftover queue from a previous cancelled run:
   ```typescript
   sendUserMessage: async (prompt, onEvent) => {
     hasWarnedAboutSafetyTrim = false;
     
     // Drain any messages queued before this sendUserMessage began
     // (e.g. from a previous cancelled request — preserve policy)
     while (pendingMessages.length > 0) {
       const queued = pendingMessages.shift()!;
       sessionManager.appendUserMessage(queued);
       engine.runConversationEventHooks({
         kind: 'userMessage',
         content: queued,
       }).catch(err => logger.warn(`Event hook threw: ${err}`));
     }
     
     sessionManager.appendUserMessage(prompt);
     // ... existing event hook fire (unchanged) ...
   ```

5. At the **top of the `while(true)` loop** (after the budget key check, before system messages), add:
   ```typescript
   // ── Soft cancel check ──
   if (cancelled) {
     cancelled = false;
     return CANCEL_SENTINEL;
   }
   
   // ── Drain queued messages ──
   while (pendingMessages.length > 0) {
     const queued = pendingMessages.shift()!;
     sessionManager.appendUserMessage(queued);
     engine.runConversationEventHooks({
       kind: 'userMessage',
       content: queued,
     }).catch(err => logger.warn(`Event hook threw: ${err}`));
   }
   ```

6. Add the new methods to the returned object:
   ```typescript
   enqueueUserMessage: (prompt: string) => {
     pendingMessages.push(prompt);
   },
   cancelCurrentRequest: () => {
     cancelled = true;
   },
   ```

7. Update `clearSession` to also clear the pending queue:
   ```typescript
   clearSession: () => {
     hasWarnedAboutSafetyTrim = false;
     pendingMessages.length = 0;
     cancelled = false;
     sessionManager.clearSession();
   },
   ```

### Step 2: Export CANCEL_SENTINEL from the public lib

**File:** `drone-agent/src/lib.ts`

Add:
```typescript
export { CANCEL_SENTINEL } from './runtime/conversation-service.js';
```

### Step 3: Update the TUI to route input based on LLM activity

**File:** `drone-agent/src/tui/app.tsx`

**Changes:**

1. Import `CANCEL_SENTINEL`:
   ```typescript
   import { CANCEL_SENTINEL } from '../runtime/conversation-service.js';
   ```

2. Add a `cancelRequestedRef` ref:
   ```typescript
   const cancelRequestedRef = useRef(false);
   ```

3. Change the `onSubmit` handler on `<InputLine>`:
   ```typescript
   onSubmit={value => {
     setInput('');
     const trimmed = value.trim();
     if (trimmed.length === 0) return;
     
     // Route: if LLM is active, enqueue or cancel
     if (isLlmActive) {
       // /cancel fires immediately even when busy
       if (trimmed === '/cancel') {
         opts.conversation.cancelCurrentRequest?.();
         cancelRequestedRef.current = true;
         log('Cancelled current request.', 'info');
         return;
       }
       // All other input while busy — queue it
       opts.conversation.enqueueUserMessage?.(trimmed);
       log(`> ${trimmed}`, 'user');
       return;
     }
     
     // Normal path: fire runSlashCommand
     void runSlashCommand(value);
   }}
   ```

4. Inside `runSlashCommand`, handle the cancel sentinel:
   ```typescript
   const response = await opts.conversation.sendUserMessage(
     trimmed,
     event => { /* existing handler */ }
   );
   
   if (response === CANCEL_SENTINEL) {
     cancelRequestedRef.current = false;
     // Don't log anything extra, don't run onAfterToolCall hooks
   } else {
     if (!assistantRendered && response.length > 0) {
       log(response, 'plain');
     }
     await opts.engine.runHooks('onAfterToolCall');
   }
   ```

### Step 4: Repurpose ESC — cancel if active, no-op otherwise

**File:** `drone-agent/src/tui/app.tsx`

Replace the current ESC-as-exit with cancel-only:
```typescript
useInput((input, key) => {
  if (key.escape) {
    if (isLlmActive) {
      opts.conversation.cancelCurrentRequest?.();
      cancelRequestedRef.current = true;
      log('Cancelled current request.', 'info');
    }
    // ESC when idle is a no-op — Ctrl-C is the exit route
    return;
  }
  if (key.ctrl && input === 'c') {
    exit();
    return;
  }
  // ... existing ? handler ...
});
```

Also update the help text in `printHelp()` to reflect the new ESC behavior:
```typescript
const helpLines: string[] = [
  'Keybindings:',
  '',
  '  Ctrl+C            Quit',
  '  Ctrl+C twice      Force quit',
  '  Escape            Cancel current request (when LLM is active)',
  '  F1 / ?            Show this help',
  '  Ctrl+J            Insert newline in multi-line input',
  '',
  'Text selection:',
  '',
  ...
];
```

### Step 5: Update the ConversationService type in DroneSlashCommandContext

**File:** `drone-core/src/plugin-system.ts` (line ~272)

Add `enqueueUserMessage` and `cancelCurrentRequest` to the `conversation?` shape in `DroneSlashCommandContext`:
```typescript
conversation?: {
  getModel: () => string;
  setModel: (model: string) => void;
  sendUserMessage: (prompt: string, onEvent?: (event: unknown) => void) => Promise<string>;
  clearSession?: () => void;
  // NEW:
  enqueueUserMessage?: (prompt: string) => void;
  cancelCurrentRequest?: () => void;
};
```

### Step 6: Update the TUI's DroneTuiOptions.conversation type

**File:** `drone-agent/src/tui/types.ts` (lines ~93-101)

Add the two new methods to the conversation shape:
```typescript
conversation: {
  sendUserMessage: (prompt: string, onEvent?: ...) => Promise<string>;
  clearSession: () => void;
  getEstimatedContextUsagePercent: () => Promise<number>;
  setModel: (newModel: string) => void;
  getModel: () => string;
  // NEW:
  enqueueUserMessage?: (prompt: string) => void;
  cancelCurrentRequest?: () => void;
};
```

### Step 7: Update the readline mode — no explicit changes needed

**File:** `drone-agent/src/interactive.ts` (lines ~210-214)

The `sendUserMessage` wrapper in the slash command context automatically gets the new methods since it wraps the full `ConversationService`. The type extension from Step 5 handles it. No explicit code changes needed.

### Step 8: Add unit tests for the queue and cancel behavior

**File:** `drone-agent/test/conversation-service.test.ts`

New `describe('createConversationService — message queue')` block:

1. **Test: queued messages are drained before LLM call on next loop iteration**
   - Provider returns: [toolCalls=[{id:'1', name:'fake_tool', arguments:{}}], {message:"done"}]
   - Engine registers a no-op `fake_tool`
   - Before calling sendUserMessage, enqueue "queued-1" and "queued-2"
   - After sendUserMessage completes, assert session has both queued messages as user turns

2. **Test: cancelCurrentRequest causes early return with sentinel**
   - Provider returns toolCalls, then more toolCalls (to keep loop going)
   - Call sendUserMessage("go")
   - From within the tool execution (via executeToolImpl), call `conversation.cancelCurrentRequest()`
   - Assert sendUserMessage resolves to CANCEL_SENTINEL

3. **Test: cancel preserves queued messages for next call**
   - Enqueue "preserve-me" before starting
   - Call sendUserMessage("first"), cancel from within tool execution
   - Assert return is CANCEL_SENTINEL
   - Call sendUserMessage("second") fresh
   - Assert "preserve-me" appears in session (drained at start of second call)

4. **Test: clearSession flushes the queue**
   - Enqueue a message
   - Call conversation.clearSession()
   - Start a fresh sendUserMessage("hello")
   - Assert only "hello" is in session (queued message was cleared)

### Step 9: Update TUI test to cover routing

**File:** `drone-agent/test/tui.test.tsx`

Update the `makeOptions` conversation mock to include `enqueueUserMessage` and `cancelCurrentRequest` as no-op functions. Verify the TUI renders without error.

### Step 10: Fix LSP errors in existing test mocks

**File:** `drone-agent/test/llm-provider-switching.test.ts`

The existing mock objects at lines 214 and 244 are missing the `getModel` property (type error). Add it plus the two new optional methods:
```typescript
getModel: () => 'fake',
enqueueUserMessage: vi.fn(),
cancelCurrentRequest: vi.fn(),
```

## Validation Criteria

1. **LSP checks** — `pnpm typecheck` passes with no errors across all packages
2. **Existing tests pass** — `pnpm test` passes (no regressions)
3. **New tests pass** — all tests in Step 8 pass
4. **Manual TUI smoke test**:
   - Start the TUI
   - Send a message that triggers a multi-tool chain (e.g., "explore this project")
   - While the tool chain is running, type a second message (e.g., "actually, focus on tests")
   - Verify the second message appears in the chat log and the tool chain finishes before the LLM responds to it
   - While the LLM responds to that, hit ESC — verify "Cancelled" appears and the LLM stops
   - Verify that pressing ESC when idle does nothing
   - Verify Ctrl-C still exits
5. **`pnpm lint` passes**
6. **Smoke test readline mode** (no regression): basic `--once` or readline mode still works
---
key: conversation-event-push-through-plan
tags:
  - plan
  - swarm
  - conversation-events
  - coordinator
created: 2026-06-30T05:02:14.469Z
updated: 2026-06-30T05:02:14.469Z
---

# Plan: Wire Up Conversation Event Push-Through to Coordinator

## Summary

The swarm plugin declares an `eventBuffer` and a `flushEventBuffer()` function, and registers `onBeforePrompt` and `onAfterToolCall` hooks — but **nothing ever pushes events into the buffer**. This plan adds a new `onConversationEvent` hook to the plugin system, moves the `ConversationEvent` type to `drone-core`, wires the conversation service to fire events through the hook, and connects the swarm plugin to consume them.

## Step 1: Move `ConversationEvent` type to `drone-core`

**File:** `drone-core/src/session-types.ts`

Add the `DroneConversationEvent` type (currently `ConversationEvent` in `drone-agent/src/runtime/conversation-service.ts`) to the session types in `drone-core`. Add a `userMessage` variant to capture user prompts.

```ts
export type DroneConversationEvent =
  | { kind: 'userMessage'; content: string }
  | { kind: 'reasoning'; content: string }
  | { kind: 'assistantMessage'; content: string }
  | { kind: 'toolCall'; name: string; arguments: Record<string, unknown> }
  | {
      kind: 'toolResult';
      name: string;
      content: string;
      arguments: Record<string, unknown>;
    }
  | { kind: 'error'; message: string };
```

**File:** `drone-core/src/index.ts`

Export the new type:

```ts
export type { DroneConversationEvent } from './session-types.js';
```

**File:** `drone-agent/src/runtime/conversation-service.ts`

Update the import to use `DroneConversationEvent` from `drone-core` instead of the local `ConversationEvent` type. Remove the local type definition. Keep the local `ConversationEventHandler` alias referencing the new type.

## Step 2: Add `onConversationEvent` hook to `DronePluginHooks`

**File:** `drone-core/src/plugin-system.ts`

Add the new hook to the `DronePluginHooks` interface:

```ts
export type DronePluginHooks = {
  // ... existing hooks ...
  onConversationEvent: (
    callback: (
      event: import('./session-types.js').DroneConversationEvent
    ) => Promise<void>
  ) => void;
};
```

This hook carries a payload (the event), so it follows the same pattern as `onSessionSafetyTrimWillRun` / `onSessionSafetyTrimApplied` — it gets its own dedicated engine method, not `runHooks`.

## Step 3: Wire the hook in the plugin engine

**File:** `drone-agent/src/runtime/plugin-engine.ts`

1. Import `DroneConversationEvent` from `drone-core`.
2. Add a new bucket array:
   ```ts
   const conversationEventHooks: Array<
     (event: DroneConversationEvent) => Promise<void>
   > = [];
   ```
3. In the registration object's `hooks` property, add the wiring:
   ```ts
   onConversationEvent: callback =>
     conversationEventHooks.push(callback),
   ```
4. Add a new method to the `DronePluginEngine` interface and the return object:
   ```ts
   runConversationEventHooks: async (event: DroneConversationEvent) => {
     for (const callback of conversationEventHooks) {
       await callback(event);
     }
   },
   ```

## Step 4: Fire events from the conversation service

**File:** `drone-agent/src/runtime/conversation-service.ts`

In the `sendUserMessage` function:

1. After `sessionManager.appendUserMessage(prompt)`, fire a user message event:

   ```ts
   await engine.runConversationEventHooks({
     kind: 'userMessage',
     content: prompt,
   });
   ```

2. In the `emit` function, also fire the engine hook for each event (fire-and-forget with `.catch()` so a slow or failing hook doesn't block the conversation loop):
   ```ts
   const emit = (event: DroneConversationEvent): void => {
     if (onEvent) {
       try {
         onEvent(event);
       } catch (err) { ... }
     }
     engine.runConversationEventHooks(event).catch(err => {
       logger.warn(`Conversation event hook threw: ${err}`);
     });
   };
   ```

## Step 5: Wire the swarm plugin to consume events

**File:** `drone-agent/src/plugins/swarm/index.ts`

In the `register` function, add a new hook registration that pushes events into the `eventBuffer`:

```ts
registration.hooks.onConversationEvent(async event => {
  const now = Date.now();
  const evt = {
    id: generateUuid(),
    sessionId,
    correlationId: currentCorrelationId ?? undefined,
    type: event.kind,
    payload: JSON.stringify(event),
    metadata: JSON.stringify({
      kind: event.kind,
      ...('name' in event ? { name: event.name } : {}),
    }),
    createdAt: now,
  };
  eventBuffer.push(evt);
});
```

The existing `onAfterToolCall` hook already calls `flushEventBuffer()`, so events will be pushed to the coordinator after each tool iteration. The `onBeforePrompt` hook already generates a new `correlationId` for each user turn.

## Step 6: Update the `DronePluginRegistration` type

**File:** `drone-core/src/plugin-system.ts`

The `DronePluginRegistration` type already has `hooks: DronePluginHooks`, so no changes needed — the new hook method is automatically available to all plugins.

## Step 7: Update tests

**File:** `drone-agent/test/conversation-service.test.ts`

The test's `makeEngine()` mock needs a `runConversationEventHooks` method (no-op). Add it to the mock engine object.

**File:** `drone-agent/test/fixtures/swarm.ts` (if it exists)

Check if the swarm test fixture needs updating for the new hook.

## Step 8: Build and typecheck

```bash
pnpm build
pnpm typecheck
```

## Validation Criteria

1. `pnpm build` succeeds with no errors
2. `pnpm typecheck` passes with no errors
3. `pnpm test` passes (all existing tests)
4. `pnpm lint` passes
5. LSP diagnostics show zero errors across the workspace
6. Manual verification: with a coordinator running, start a drone-agent session with the swarm plugin enabled, send a few messages, then query the coordinator database:
   ```bash
   sqlite3 ./config/drone-coordinator.db "SELECT type, substr(payload, 1, 80) FROM swarm_events ORDER BY createdAt DESC LIMIT 20;"
   ```
   Expected: rows with types like `userMessage`, `reasoning`, `assistantMessage`, `toolCall`, `toolResult`

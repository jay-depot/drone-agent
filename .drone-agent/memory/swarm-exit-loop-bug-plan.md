---
key: swarm-exit-loop-bug-plan
tags:
  - plan
  - swarm
  - bugfix
created: 2026-06-30T04:13:01.174Z
updated: 2026-06-30T04:13:01.174Z
---

# Plan: Fix Infinite WebSocket Reconnection Loop on `/exit` in Swarm Mode

## Summary

When swarm mode is enabled and the user types `/exit` (or `/quit`), the agent enters an infinite loop printing `[swarm] WebSocket connected to beacon` followed by `[swarm] WebSocket closed: 4002 Agent not registered` to the terminal. The process never exits.

## Root Cause

The swarm plugin's WebSocket reconnection logic has no awareness of a deliberate shutdown. The sequence is:

1. `/exit` → TUI calls `exit()` → `main()` calls `engine.runHooks('onShutdown')`
2. The swarm plugin's `onShutdown` hook runs: `clearInterval(heartbeatInterval)`, then `if (ws) ws.close()`, then `await fetch(DELETE /agents/${sessionId})`
3. `ws.close()` triggers the `onclose` handler **synchronously** (or before the DELETE fetch completes)
4. `onclose` sees `wsReconnectAttempts` (0) < `maxReconnectAttempts` (5) → schedules a reconnect via `setTimeout`
5. The reconnect succeeds — `onopen` fires and **resets `wsReconnectAttempts` to 0**
6. The beacon rejects the connection because the agent was already deleted → sends close code `4002`
7. `onclose` fires again → `wsReconnectAttempts` (0) < 5 → schedules reconnect
8. **Infinite loop** — the `onopen` keeps resetting the counter, so the reconnect limit is never reached

## Fix Strategy

Add a `shuttingDown` flag that is set to `true` in the `onShutdown` hook **before** calling `ws.close()`. The `onclose` handler checks this flag and skips reconnection if the shutdown is in progress.

## Implementation Steps

### Step 1: Add `shuttingDown` flag to the swarm plugin's register closure

**File:** `drone-agent/src/plugins/swarm/index.ts`

**Location:** Near line 460, alongside the other WebSocket state variables (`ws`, `wsReconnectAttempts`, `maxReconnectAttempts`, `messageQueue`, `pendingMessages`).

**Change:** Add a new variable:
```typescript
let shuttingDown = false;
```

### Step 2: Guard the reconnection logic in `onclose`

**File:** `drone-agent/src/plugins/swarm/index.ts`

**Location:** The `ws.onclose` handler, around line 423.

**Change:** Add a guard at the top of the `onclose` handler:
```typescript
ws.onclose = event => {
  registration.logger.warn(
    `WebSocket closed: ${event.code} ${event.reason}`
  );
  ws = null;
  if (shuttingDown) {
    registration.logger.info('WebSocket closed during shutdown; skipping reconnect');
    return;
  }
  if (wsReconnectAttempts < maxReconnectAttempts) {
    wsReconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, wsReconnectAttempts),
      30000
    );
    setTimeout(connectWebSocket, delay);
  }
};
```

### Step 3: Set `shuttingDown = true` in `onShutdown` before closing the WebSocket

**File:** `drone-agent/src/plugins/swarm/index.ts`

**Location:** The `onShutdown` hook, around line 908.

**Change:** Set the flag before calling `ws.close()`:
```typescript
registration.hooks.onShutdown(async () => {
  shuttingDown = true;
  clearInterval(heartbeatInterval);
  if (ws) ws.close();
  await flushEventBuffer();
  if (beaconConfigInjector && configCap) {
    configCap.unregisterInjector(beaconConfigInjector.id);
  }
  try {
    await fetch(`${baseUrl}/agents/${sessionId}`, {
      method: 'DELETE',
    });
  } catch {
    // Silently ignore cleanup failures
  }
});
```

### Step 4: Verify the fix

**Validation criteria:**
1. `pnpm build` passes (no TypeScript errors)
2. `pnpm lint` passes (no lint errors)
3. `pnpm test` passes (all existing tests)
4. Manual verification: Start drone-agent with swarm mode enabled, type `/exit`, observe that the process exits cleanly without the infinite reconnection loop

## Validation Criteria

- [ ] `pnpm build` succeeds
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] LSP diagnostics show no errors or warnings
- [ ] Manual test: `/exit` in swarm mode exits cleanly without infinite reconnection loop

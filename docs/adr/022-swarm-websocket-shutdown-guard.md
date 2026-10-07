---
tags: [decision, swarm]
related: [swarm-architecture.md, drone-agent-plugins.md]
---

# 022 — Swarm WebSocket Shutdown Guard

**Summary**: Added a `shuttingDown` flag to the swarm plugin's WebSocket client to prevent an infinite reconnection loop when the agent exits via `/exit` or `/quit`.

## Context

When swarm mode is enabled and the user types `/exit`, the agent would enter an infinite loop printing `[swarm] WebSocket connected to beacon` followed by `[swarm] WebSocket closed: 4002 Agent not registered` to the terminal. The process never exited.

## Root Cause

The swarm plugin's WebSocket reconnection logic had no awareness of a deliberate shutdown. The sequence was:

1. `/exit` → TUI calls `exit()` → `main()` calls `engine.runHooks('onShutdown')`
2. The swarm plugin's `onShutdown` hook runs: `clearInterval(heartbeatInterval)`, then `if (ws) ws.close()`, then `await fetch(DELETE /agents/${sessionId})`
3. `ws.close()` triggers the `onclose` handler (synchronously or before the DELETE fetch completes)
4. `onclose` sees `wsReconnectAttempts` (0) < `maxReconnectAttempts` (5) → schedules a reconnect via `setTimeout`
5. The reconnect succeeds — `onopen` fires and **resets `wsReconnectAttempts` to 0**
6. The beacon rejects the connection because the agent was already deleted → sends close code `4002`
7. `onclose` fires again → `wsReconnectAttempts` (0) < 5 → schedules reconnect
8. **Infinite loop** — the `onopen` keeps resetting the counter, so the reconnect limit is never reached

## Decision

Add a `shuttingDown` boolean flag alongside the other WebSocket state variables. The flag is set to `true` in the `onShutdown` hook **before** calling `ws.close()`. The `onclose` handler checks this flag and skips reconnection if the shutdown is in progress.

## Implementation

Three changes to `drone-agent/src/plugins/swarm/index.ts`:

1. **Added `shuttingDown` flag** — `let shuttingDown = false;` alongside `ws`, `wsReconnectAttempts`, etc.
2. **Guarded reconnection in `onclose`** — if `shuttingDown` is true, log a message and return early instead of scheduling a reconnect
3. **Set flag in `onShutdown`** — `shuttingDown = true` is set before `ws.close()`, ensuring the `onclose` handler sees the flag

## Related

- swarm-architecture — Swarm mode
- [drone-agent-plugins](../../drone-agent/src/plugins/) — Swarm plugin
- swarm-connection — Connection flow

---
tags: [decision, mcp, resilience, reconnect, respawn]
related: [modules/drone-agent-mcp-client.md, decisions/054-mcp-http-sse-stream-delete.md, decisions/050-mcp-client-session-id-iserror.md]
---

# Decision 060: MCP Client SSE Reconnect + Stdio Respawn (Points 15 & 16)

**Status**: Implemented

**Date**: 2026-07-11

## Context

The MCP client had two resilience gaps identified in the `mcp-client-gaps` audit:

- **Point 15**: The streamable-HTTP GET SSE stream (added in point 8, [[decisions/054-mcp-http-sse-stream-delete]]) was fire-and-forget — if the stream dropped due to a transient network issue, it stayed closed until the next connection. The `streaming` flag was set once and never updated.

- **Point 16**: A crashed stdio child process left the connection permanently dead. The `onTransportIssue` callback set `state.status = 'error'` but nothing ever attempted to respawn the child. The only recovery path was a full agent restart.

Both gaps share a common pattern: a background monitor loop that detects when a transport has failed, waits with exponential backoff, and re-establishes the connection.

## Decision

### 1. SSE Stream Reconnection (Point 15)

The `openGetStream()` function in `createStreamableHttpJsonRpcClient` was changed from a single-shot attempt to a retry loop:

- **On successful open**: reset backoff to 1s, set `streaming = true`, fire `onStreamReconnected`.
- **On normal close** (server closes the stream, `done = true`): set `streaming = false`, wait 1s, then retry.
- **On error** (network failure, non-2xx response): set `streaming = false`, call `onStreamError`, wait with exponential backoff (1s, 2s, 4s, 8s, ... capped at 60s), then retry.
- **On `disconnect()`**: the `closed` flag stops the loop immediately.
- **On `AbortError`**: exit the loop silently (raised by `disconnect`).

The `streaming` flag now accurately reflects the current stream state: `true` when open, `false` when dropped, `true` again on reconnect.

An `onStreamReconnected` callback was added to the HTTP builder options (separate from `onStreamError`). The plugin layer wires this to clear `lastStreamError` on `state`.

### 2. Stdio Child Respawn (Point 16)

A `startRespawnMonitor()` function was added to `createMcpClientConnection`, started after the initial connection succeeds for spawned (stdio) servers:

- The monitor polls `state.status` every 200ms. When it sees `'error'` (set by `onTransportIssue` when the child crashes), it begins respawn attempts.
- Each attempt: spawn a new child process, create a new transport, send `initialize`, send `notifications/initialized`.
- On success: swap in the new `childProcess` and `rpc` references, set `status = 'connected'`, clear `lastError`/`lastErrorCategory`, reset backoff to 1s, fire `onReconnected`, increment `reconnectCount`.
- On failure: wait with exponential backoff (1s, 2s, 4s, ..., capped at 60s) and retry.
- On `disconnect()`: the `closed` flag stops the monitor loop.

### 3. Tool Re-mounting on Reconnect

When a stdio child respawns, the old tool registrations must be cleared before re-mounting. This required:

- **`unregisterPluginTools(pluginId)`** on `DronePluginEngine` and `DronePluginRegistration` — iterates the plugin's registered tools, removes each from the global `tools` map, and clears the plugin's tool list so subsequent `registerTool` calls won't hit the duplicate check.
- **`onReconnected` callback** on `createMcpClientConnection` — fires after a successful respawn/re-initialize.
- The MCP plugin's `onPluginsLoaded` hook wires `onReconnected` to: call `registration.unregisterPluginTools('mcp')`, re-list tools from the connection, re-apply `allowedTools` filtering, re-mount via `mountMcpTools`/`mountResourcePromptTools`, and update server state.

### 4. State Tracking

`DroneMcpServerState` gained `reconnectCount?: number` — incremented on each successful reconnect (SSE stream or stdio child). Useful for diagnostics and the `server_status` tool.

## Consequences

### Positive

- The SSE stream is now resilient to transient network drops — it reconnects automatically with backoff.
- A crashed stdio child is respawned automatically — no more dead connections requiring a restart.
- Tools are re-listed and re-mounted on respawn, so the LLM always sees the current tool set.
- The `streaming` flag is now an accurate live indicator of stream state.
- `reconnectCount` provides observability into connection stability.

### Negative / tradeoffs

- The respawn monitor polls `state.status` every 200ms — minimal overhead but not event-driven.
- If the child process crashes repeatedly, the backoff delays recovery (intentional — prevents tight crash loops).
- The `onReconnected` callback re-lists all tools on every respawn, which could be expensive for servers with many tools. Acceptable for the common case.

## Implementation notes (gotchas discovered)

- The `startRespawnMonitor` function accesses stdio-only config properties (`command`, `args`, `cwd`, `env`, `encoding`). These must be narrowed from the `DroneMcpServerConfig` union type via `as DroneMcpStdioServerConfig` since the function is only called for spawned (stdio) connections.
- The `disconnect()` method needed a `closed` flag at the `createMcpClientConnection` level (not just inside the `JsonRpcClient`) so the respawn monitor loop can observe it.
- The SSE reconnection implementation initially broke the HTTP transport architecture by routing POST responses through the GET SSE stream instead of reading them from the HTTP response body. This was caught by the test suite and corrected.

## Implementation

- **Commits**: `4c3f852` (step 1: unregisterPluginTools), `006fa28` (step 2: onReconnected callback), `8b7a21a` (step 3: SSE reconnection), `2e0efcd` (step 4: stdio respawn), `31f69a6` (step 5: reconnectCount), `6da252c` (step 6: plugin layer wiring), `25b01b5` (fix: type errors + syntax + architecture regression)
- **Files**: `drone-core/src/mcp-types.ts`, `drone-core/src/plugin-system.ts`, `drone-core/src/index.ts`, `drone-agent/src/runtime/plugin-engine.ts`, `drone-agent/src/plugins/mcp/client.ts`, `drone-agent/src/plugins/mcp/index.ts`, `drone-agent/test/helpers.ts`
- **Validation**: `pnpm typecheck` (all packages), `pnpm test` (96 files / 1401 passed), LSP clean (hints only, no errors/warnings).

## Related

- [[modules/drone-agent-mcp-client]] — The client module page (updated for SSE reconnect + stdio respawn).
- [[decisions/054-mcp-http-sse-stream-delete]] — The point-8 fix that established the GET SSE stream (now with auto-reconnect).
- [[decisions/050-mcp-client-session-id-iserror]] — Earlier MCP client fix (session-id capture + isError throwing).
- [[decisions/051-mcp-client-test-suite]] — The two-layer test harness.

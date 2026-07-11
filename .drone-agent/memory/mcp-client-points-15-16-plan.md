---
key: mcp-client-points-15-16-plan
tags:
  - mcp
  - plan
  - resilience
  - reconnect
  - respawn
created: 2026-07-11T16:38:32.767Z
updated: 2026-07-11T16:38:32.767Z
---

# Plan: MCP Client Points 15 & 16 — SSE Reconnect + Stdio Respawn

## Summary

Implement two resilience features for MCP client connections:

- **Point 15**: Auto-reconnect the streamable HTTP GET SSE stream on transient drop/close with exponential backoff.
- **Point 16**: Auto-respawn crashed stdio MCP child processes with exponential backoff, re-listing and re-mounting tools on successful reconnect.

Both share a common pattern: a background monitor loop that detects when a transport has failed, waits with backoff, and re-establishes the connection. The SSE reconnect is simpler (just re-open the GET stream). The stdio respawn is more involved (spawn a new child, re-initialize, re-list tools, re-mount).

## Prerequisite: Add `unregisterPluginTools` to the engine

The engine's `registerTool` throws on duplicate names. To re-mount tools after a respawn, we need to clear old registrations first. This is also needed for item 6 (handling `notifications/tools/list_changed`).

## Step-by-step plan

### Step 1: Add `unregisterPluginTools(pluginId)` to the engine

**File**: `drone-agent/src/runtime/plugin-engine.ts`

Add a new method to the `DronePluginEngine` type and implementation:

```typescript
// In the DronePluginEngine type:
unregisterPluginTools: (pluginId: string) => void;

// In the implementation:
unregisterPluginTools: (pluginId: string) => {
  const registered = pluginRegistry.get(pluginId);
  if (!registered) return;
  for (const tool of registered.tools) {
    const canonicalName = getCanonicalToolName(pluginId, tool.name);
    tools.delete(canonicalName);
  }
  registered.tools = [];
},
```

This iterates the tools registered by the given plugin, removes each from the global `tools` map, and clears the plugin's tool list so subsequent `registerTool` calls won't hit the duplicate check.

**Test**: Add a test in `drone-agent/test/plugin-engine.test.ts` that registers tools, calls `unregisterPluginTools`, then re-registers the same tool names successfully.

### Step 2: Add `onReconnected` callback to `createMcpClientConnection`

**File**: `drone-agent/src/plugins/mcp/client.ts`

Add an `onReconnected` callback to the `createMcpClientConnection` options. This fires after a successful respawn/re-initialize so the plugin layer can re-list and re-mount tools.

```typescript
// In the options type:
onReconnected?: () => void;

// In the initialize success path (after state.status = 'connected'):
if (options.onReconnected) {
  options.onReconnected();
}
```

This is a simple hook point — the plugin layer will wire it up in Step 5.

### Step 3: Implement SSE stream reconnection in `createStreamableHttpJsonRpcClient`

**File**: `drone-agent/src/plugins/mcp/client.ts`

Modify `openGetStream()` to loop on failure with exponential backoff instead of exiting. The loop:

1. Attempt to open the GET stream (existing logic).
2. If the stream ends normally (server closes it, `done` is true), wait 1s and retry (the server might come back).
3. If the stream errors (network failure), call `onStreamError`, wait with exponential backoff (1s, 2s, 4s, 8s, ... capped at 60s), then retry.
4. If `closed` is true (disconnect was called), exit the loop immediately.
5. Reset the backoff delay to 1s on a successful stream open.

The `streaming` flag should be set to `true` when the stream opens and `false` when it drops. The `lastStreamError` should be cleared on successful reconnection.

```typescript
async function openGetStream(): Promise<void> {
  let backoffMs = 1000;
  while (!closed) {
    try {
      const response = await fetch(options.url, { ... });
      if (!response.ok || !response.body) {
        options.onStreamError(`GET stream returned ${response.status}`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60000);
        continue;
      }
      // Successfully opened — reset backoff and mark streaming
      backoffMs = 1000;
      options.onStreamReconnected?.();
      const reader = response.body.getReader();
      // ... existing SSE reading loop ...
      // If we get here, the stream ended normally (server closed it)
      if (!closed) {
        await sleep(1000); // brief pause before retry
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      options.onStreamError(error instanceof Error ? error.message : String(error));
      if (!closed) {
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60000);
      }
    }
  }
}
```

Add an `onStreamReconnected` callback to the options (separate from `onStreamError` — fires when the stream successfully opens after a drop). The plugin layer uses this to clear `lastStreamError`.

**Test** (in `mcp-client.test.ts`):
- Test that after an SSE stream error, the client retries and reconnects (mock the fetch to fail once then succeed).
- Test that the backoff delay increases between retries.
- Test that `disconnect()` stops the retry loop.
- Test that `streaming` flips to `false` on error and back to `true` on reconnect.
- Test that `lastStreamError` is cleared on reconnect.

### Step 4: Implement stdio child respawn in `createMcpClientConnection`

**File**: `drone-agent/src/plugins/mcp/client.ts`

Add a background respawn loop for spawned (stdio) connections. After the initial connection is established, start a monitor that watches for the transport to die.

The approach: modify the `onTransportIssue` callback to also trigger a respawn attempt. The respawn logic:

1. When `onTransportIssue` fires (child crashed), set `state.status = 'error'`.
2. Start a respawn loop with exponential backoff (1s, 2s, 4s, ..., capped at 60s).
3. In each attempt: spawn a new child, create a new transport, send `initialize`.
4. On success: update `state` (new child process reference), set `status = 'connected'`, clear `lastError`, fire `onReconnected`, and exit the loop.
5. On failure: wait with backoff and retry.
6. If `closed` is true (disconnect was called), exit the loop.

The tricky part: the `childProcess` variable is captured in closures. We need to update it on respawn so `disconnect()` can kill the new child.

```typescript
// After the initial connection is established (inside createMcpClientConnection):
if (state.ownership === 'spawned') {
  startRespawnMonitor();
}

function startRespawnMonitor(): void {
  let backoffMs = 1000;
  const monitor = async () => {
    while (!closed) {
      // Wait for status to become 'error' (set by onTransportIssue)
      if (state.status !== 'error') {
        await sleep(200);
        continue;
      }
      // Attempt respawn
      try {
        const newChild = spawn(config.command, config.args ?? [], { ... });
        const newRpc = createStdioJsonRpcClient({
          transport: createChildTransport(newChild),
          requestTimeoutMs: effectiveRequestTimeoutMs,
          onTransportIssue: error => {
            state.status = 'error';
            state.lastError = error;
            state.lastErrorCategory = classifyErrorCategory(error);
          },
          encoding: config.encoding,
        });
        await newRpc.request('initialize', { ... });
        newRpc.notify('notifications/initialized', {});
        // Success — swap in the new transport
        childProcess = newChild;
        rpc = newRpc;
        state.status = 'connected';
        state.lastError = undefined;
        state.lastErrorCategory = undefined;
        backoffMs = 1000;
        options.onReconnected?.();
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        state.lastErrorCategory = classifyErrorCategory(error);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60000);
      }
    }
  };
  void monitor();
}
```

**Important**: The `disconnect()` method needs to set `closed = true` on the outer scope so the monitor loop exits. Currently `closed` is only on the `JsonRpcClient` — we need a `closed` flag at the `createMcpClientConnection` level too.

**Test** (in `mcp.test.ts` — slow integration suite):
- Test that when a stdio child exits, the client respawns a new one (verify via spawn spy).
- Test that after respawn, tools are still callable.
- Test that `disconnect()` kills the respawned child and stops the retry loop.
- Test that the backoff delay increases between failed respawn attempts.

### Step 5: Wire respawn/reconnect into the plugin layer (`index.ts`)

**File**: `drone-agent/src/plugins/mcp/index.ts`

Modify the `onPluginsLoaded` hook to:

1. Pass an `onReconnected` callback to `createMcpClientConnection`.
2. In the `onReconnected` callback:
   a. Call `engine.unregisterPluginTools('mcp')` to clear old tool registrations.
   b. Re-list tools from the connection.
   c. Re-apply `allowedTools` filtering.
   d. Re-mount tools via `mountMcpTools` and `mountResourcePromptTools`.
   e. Update the server state with new tool counts.

The challenge: the `onReconnected` callback needs access to the engine's `unregisterPluginTools` method. The `registration` object doesn't expose the engine directly. We need to get a reference to it.

**Approach**: The MCP plugin already has access to `registration` during `onPluginsLoaded`. We can capture the engine reference by requesting the engine's capability or by storing a reference. Looking at the existing pattern, the `registration` object has `registerTool` but not `unregisterPluginTools`. 

The cleanest approach: add `unregisterPluginTools` to the `DronePluginRegistration` type so plugins can call it during their lifecycle hooks. This is a small addition to `drone-core/src/plugin-system.ts`.

```typescript
// In DronePluginRegistration:
unregisterPluginTools: (pluginId: string) => void;
```

And wire it in the engine's `register()` implementation:

```typescript
unregisterPluginTools: (pluginId: string) => {
  engine.unregisterPluginTools(pluginId);
},
```

Then in `index.ts`:

```typescript
const onReconnected = async () => {
  if (!connection) return;
  // Clear old tool registrations
  registration.unregisterPluginTools('mcp');
  // Re-list and re-mount
  const tools = await connection.listTools();
  const allowlist = serverConfig.allowedTools;
  const allowedToolSet = allowlist ? new Set(allowlist) : undefined;
  const mountedTools = allowedToolSet
    ? tools.filter(tool => allowedToolSet.has(tool.name))
    : tools;
  connection.state.discoveredToolCount = tools.length;
  connection.state.filteredToolCount = tools.length - mountedTools.length;
  connection.state.mountedToolCount = mountedTools.length;
  mountMcpTools(serverId, connection, mountedTools);
  mountResourcePromptTools(serverId, connection);
  setServerState(connection.state);
  registration.logger.info(
    `mcp server reconnected: ${serverId} (mounted ${mountedTools.length}/${tools.length} tool(s))`
  );
};
```

### Step 6: Add `reconnectCount` to `DroneMcpServerState`

**File**: `drone-core/src/mcp-types.ts`

Add a field to track how many times the connection has reconnected:

```typescript
/** Number of times the connection has reconnected (SSE stream or stdio child). */
reconnectCount?: number;
```

This is useful for diagnostics and for the user to see via `server_status`.

### Step 7: Run tests and verify

```bash
cd /home/unleet/Projects/drone-agent
pnpm vitest run --run drone-agent/test/mcp-client.test.ts --pool=forks
pnpm vitest run --run drone-agent/test/mcp.test.ts --pool=forks
pnpm test
pnpm typecheck
```

## Validation Criteria

- [ ] `unregisterPluginTools` works: tools can be registered, unregistered, and re-registered with the same names.
- [ ] SSE stream reconnects after a transient drop with exponential backoff.
- [ ] SSE stream reconnection stops when `disconnect()` is called.
- [ ] `streaming` flag reflects current stream state (true when open, false when dropped, true again on reconnect).
- [ ] `lastStreamError` is set on drop and cleared on reconnect.
- [ ] Stdio child respawns after crash with exponential backoff.
- [ ] After stdio respawn, tools are re-listed and re-mounted (old registrations cleared).
- [ ] `disconnect()` kills the respawned child and stops the retry loop.
- [ ] `reconnectCount` increments on each successful reconnect.
- [ ] All existing tests pass (no regressions).
- [ ] `pnpm typecheck` passes.
- [ ] No LSP diagnostics errors in changed files.
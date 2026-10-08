---
tags: [decision, mcp]
related:
  [
    modules/drone-agent-mcp-client.md,
    architecture/plugin-system.md,
    decisions/050-mcp-client-session-id-iserror.md,
    decisions/054-mcp-http-sse-stream-delete.md,
    decisions/060-mcp-sse-reconnect-stdio-respawn.md,
  ]
---

# ADR 061: Handle `notifications/tools/list_changed` with Tool Re-mount

**Status**: Implemented 2026-07-11

## Context

The MCP plugin mounts tools statically at startup. If an MCP server changes its tool list (e.g., a dynamic server that adds/removes tools based on context), the client never finds out because it ignores `notifications/tools/list_changed`.

The `onNotification` callback was already plumbed through the streamable HTTP transport (from [054-mcp-http-sse-stream-delete](054-mcp-http-sse-stream-delete.md)), but:

1. The stdio transport clients (`createContentLengthJsonRpcClient` and `createLineDelimitedJsonRpcClient`) didn't dispatch notification messages at all — they silently skipped messages without an `id`.
2. The `index.ts` handler had a placeholder comment but no actual logic.
3. The `startRespawnMonitor` function created a new RPC client on respawn without passing `onNotification`, so notifications from reconnected stdio processes were lost.
4. `unregisterPluginToolsImpl` only iterated over the plugin's static tool list (registered during `register()`), but the MCP plugin registers tools dynamically via `registerTool()` at runtime. Those dynamic tools were never cleaned up, causing "Tool already registered" errors on re-mount.

## Decision

### 1. Add `onNotification` to stdio JSON-RPC clients

Both `createContentLengthJsonRpcClient` and `createLineDelimitedJsonRpcClient` now accept an `onNotification` option. Their `parseBuffer` loops dispatch notification messages (frames with a `method` and no `id`) to this callback.

### 2. Wire `onNotification` through the stdio path

The stdio branch in `createMcpClientConnection` passes `options.onNotification` to `createStdioJsonRpcClient`. The `startRespawnMonitor` function also passes it when creating the respawned RPC client.

### 3. Handle `notifications/tools/list_changed` in `index.ts`

The `onNotification` callback in `onPluginsLoaded` now checks for `method === 'notifications/tools/list_changed'` and calls `listAndMountTools()` to re-list and re-mount tools.

### 4. Extract shared re-mount logic

The tool-re-listing-and-mounting block was duplicated in three places (initial mount, `onReconnected`, and the new `list_changed` handler). It was extracted into a reusable `listAndMountTools()` function that:

1. Calls `registration.unregisterPluginTools('mcp')` to clear old tool registrations
2. Clears `mountedToolNames` set
3. Re-lists tools from the connection
4. Re-applies `allowedTools` filtering
5. Re-mounts via `mountMcpTools`/`mountResourcePromptTools`
6. Updates server state
7. Re-registers the `server_status` tool (which `unregisterPluginTools` clears)

### 5. Fix `unregisterPluginToolsImpl` for dynamic tools

The critical bug: `unregisterPluginToolsImpl` only iterated over `registered.tools` (the tools registered during the initial `register()` call), but the MCP plugin's `listAndMountTools` calls `registration.registerTool()` dynamically. Those dynamically registered tools were in the engine's `tools` map but NOT in `registered.tools`. So when `unregisterPluginToolsImpl` ran on a subsequent call, it found an empty array and didn't delete anything from the `tools` map. Then when `registerTool` was called, the tool was still in the `tools` map, causing the "Tool already registered" error.

**Fix**: iterate over the `tools` map and delete any tool whose canonical name starts with the plugin prefix (`${pluginId}__`), rather than iterating over the plugin's static tool list.

## Consequences

- **Positive**: `notifications/tools/list_changed` now triggers a full re-list and re-mount of tools, keeping the agent's tool list in sync with the MCP server.
- **Positive**: Stdio transport clients dispatch notification messages to the `onNotification` callback, enabling future notification-based features.
- **Positive**: The `unregisterPluginTools` fix ensures dynamically registered tools are properly cleaned up, preventing "Tool already registered" errors on re-mount.
- **Positive**: The extracted `listAndMountTools()` function eliminates code duplication and ensures consistent behavior across initial mount, reconnection, and list_changed events.
- **Positive**: The `server_status` tool is re-registered after each re-mount, so it remains available even after `unregisterPluginTools` clears it.
- **Positive**: Notifications from reconnected stdio processes are now dispatched (the `startRespawnMonitor` fix).
- **Neutral**: The re-mount is fire-and-forget (`void`), so a slow re-list doesn't block the notification handler.

## Files Changed

- `drone-agent/src/plugins/mcp/client.ts` — Added `onNotification` to stdio clients and respawn monitor
- `drone-agent/src/plugins/mcp/index.ts` — Extracted `listAndMountTools()`, wired `list_changed` handler
- `drone-agent/src/runtime/plugin-engine.ts` — Fixed `unregisterPluginToolsImpl` to iterate by prefix
- `drone-agent/test/mcp-fake-server.mjs` — Added notification trigger support
- `drone-agent/test/mcp-fake-server.ts` — Added `notifyOnToolName`/`notifyMethod` options
- `drone-agent/test/mcp.test.ts` — Added integration test for notification → re-mount cycle

## Related

- [drone-agent-mcp-client](../../drone-agent/src/plugins/mcp/) — The MCP client module
- [plugin-system](002-plugin-system.md) — Plugin tool registration, `unregisterPluginTools`
- [054-mcp-http-sse-stream-delete](054-mcp-http-sse-stream-delete.md) — GET SSE stream + best-effort DELETE (wired `onNotification`)
- [060-mcp-sse-reconnect-stdio-respawn](060-mcp-sse-reconnect-stdio-respawn.md) — SSE reconnect + stdio respawn (wired `onReconnected`)

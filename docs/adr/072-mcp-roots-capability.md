---
tags: [decision, mcp, roots]
related:
  [
    modules/drone-agent-mcp-client.md,
    entities/DroneAgentConfig.md,
    decisions/070-mcp-logging-capability.md,
  ]
---

# 072: MCP Roots Capability (Item 10)

**Status**: Implemented (2026-07-19)

## Context

The MCP client's `initialize` advertised `{ tools: {}, resources: {}, prompts: {}, logging: {} }` — it did not advertise `roots`. The MCP `roots` capability is a **client capability** that lets servers discover the client's filesystem roots (e.g., for resolving relative paths or scoping file operations). Without it, servers that call `roots/list` get no response, and there's no way for the client to communicate its working directory or home directory to the server.

The `roots/list` method is a **server→client request** (the server sends a JSON-RPC request with an `id`, and the client must respond with `{ roots: Array<{ uri: string; name?: string }> }`). This is a different message class than what the transport layer previously handled — it had support for client→server requests (messages with `id` matching a pending entry) and server→client notifications (messages with `method` but no `id`), but not server→client requests (messages with both `id` and `method`).

## Decision

### 1. Transport layer: `onRequest` callback

Add an `onRequest?: (method: string, params: unknown) => Promise<unknown>` callback to all three transport functions:

- `createContentLengthJsonRpcClient` (stdio, content-length framing)
- `createLineDelimitedJsonRpcClient` (stdio, line-delimited framing)
- `createStreamableHttpJsonRpcClient` (HTTP/SSE)

Message classification in `parseBuffer`:

- **Server→Client request**: has both `id` AND `method` → call `onRequest`, send response back
- **Response to our pending request**: has `id` but NO `method` → resolve/reject pending
- **Notification**: has `method` but NO `id` → call `onNotification`

Response sending:

- **stdio**: use existing `sendMessage({ id, result })` or `sendMessage({ id, error })` via a `handleServerRequest` helper
- **HTTP**: POST the JSON-RPC response back to the same server URL via a `postJsonResponse` helper

### 2. Roots handler

Add a `roots?: DroneMcpRoot[]` parameter to `createMcpClientConnection`. Wire a `handleServerRequest` function that:

- Returns `{ roots: options.roots ?? [] }` for `roots/list`
- Rejects with "Unsupported server request" for any other method

The `onRequest` callback is wired to all three transport creation sites: the main stdio connection, the streamable HTTP connection, and the respawn monitor's stdio connection.

### 3. Default roots

Computed at runtime in `index.ts` `onPluginsLoaded`:

- `file://<cwd>` with name `"Project Root"`
- `file://<home>` with name `"Home Directory"`

Merged with any additional roots from `mcp.roots` config (additive, no dedup).

### 4. Config schema

Add `DroneMcpRoot` type and `roots?: DroneMcpRoot[]` field to `DroneMcpConfig` in `drone-core/src/config-types.ts`.

### 5. Initialize capabilities

Add `roots: {}` to the capabilities object in both `initialize` calls (main handshake + respawn monitor).

## Consequences

- MCP servers that check the client's `roots` capability will now see it advertised and may call `roots/list` to discover filesystem roots.
- The transport layer now supports a new message class (server→client requests), enabling future server-initiated request handlers beyond `roots/list`.
- Default roots (CWD + home) are always present, giving servers context about the client's working environment without any config.
- Additional roots can be configured via `mcp.roots` in project or user config.
- Backward compatible: servers that don't call `roots/list` are unaffected.

## Files Changed

- `drone-core/src/config-types.ts` — Added `DroneMcpRoot` type and `roots?` field to `DroneMcpConfig`
- `drone-core/src/index.ts` — Exported `DroneMcpRoot`
- `drone-agent/src/plugins/mcp/client.ts` — Added `onRequest` to all 3 transport functions, `handleServerRequest` for `roots/list`, `roots?` param to `createMcpClientConnection`, `roots: {}` in both initialize calls
- `drone-agent/src/plugins/mcp/index.ts` — Compute default roots (CWD + home), merge with config, pass to `createMcpClientConnection`
- `drone-agent/test/mcp-client.test.ts` — 3 new tests: roots in initialize caps, roots/list response with configured roots, empty roots when unconfigured
- `drone-agent/test/mcp-fake-server.ts` — Updated mock to support SSE events with `id` (server requests) and capture response POSTs

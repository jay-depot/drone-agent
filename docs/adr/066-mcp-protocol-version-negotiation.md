---
tags: [decision, mcp]
related: [modules/drone-agent-mcp-client.md, decisions/050-mcp-client-session-id-iserror.md, decisions/054-mcp-http-sse-stream-delete.md]
---

# MCP Protocol Version Negotiation (Gap Item 4)

**Summary**: The streamable HTTP MCP transport was hardcoded to protocol version `2024-11-05` and omitted the `MCP-Protocol-Version` HTTP header required by the MCP 2025-06-18 spec. This caused the GitHub Copilot MCP server (`api.githubcopilot.com/mcp/`) to reject the `initialize` POST with 400 Bad Request.

## Problem

The MCP client had two related issues that prevented it from connecting to modern MCP servers:

1. **Missing `MCP-Protocol-Version` HTTP header** — The MCP 2025-06-18 spec requires this header on **all** HTTP requests (POST, GET, DELETE). The client omitted it entirely.

2. **Hardcoded `protocolVersion: '2024-11-05'`** — The client sent an outdated protocol version in the `initialize` body. The GitHub server expects `2025-06-18` (the version that introduced the `MCP-Protocol-Version` header requirement).

3. **Missing `text/event-stream` in `Accept` header** — The spec requires POST requests to list both `application/json` and `text/event-stream` as supported content types. The client only sent `application/json`.

4. **No SSE stream parsing for POST responses** — The spec allows servers to respond to POST requests with either `application/json` or `text/event-stream`. The GitHub server returns an SSE stream for `initialize`. The client only handled JSON.

5. **Infinite retry on 405 for GET SSE stream** — The spec says servers may return 405 to indicate they don't offer an SSE stream. The client treated 405 as a transient error and retried forever.

## Changes

### `client.ts` — `createStreamableHttpJsonRpcClient`

- Added `negotiatedProtocolVersion` variable (default `'2025-06-18'`) alongside `sessionId`
- Added `'MCP-Protocol-Version': negotiatedProtocolVersion` to POST, GET, and DELETE request headers
- Added `setProtocolVersion(version: string)` method to the returned `JsonRpcClient` object
- Added `parseSseResponse()` helper that reads an SSE stream and extracts the first JSON-RPC message with the matching id
- Updated the POST request handler to check `Content-Type` — if `text/event-stream`, parse via `parseSseResponse` instead of `JSON.parse`
- Updated the GET SSE stream handler to stop retrying on 405 Method Not Allowed (per spec, this means no SSE offered)

### `client.ts` — `JsonRpcClient` interface

- Added `setProtocolVersion: (version: string) => void` to the interface
- Implemented no-op stubs in both stdio transports (`createContentLengthJsonRpcClient`, `createLineDelimitedJsonRpcClient`) since they don't use HTTP headers

### `client.ts` — `createMcpClientConnection`

- Updated both `initialize` calls (main + respawn monitor) to use `'2025-06-18'` instead of `'2024-11-05'`
- Captured the `initialize` result and called `rpc.setProtocolVersion()` with the server's negotiated version

### `mcp-fake-server.ts`

- Updated default `protocolVersion` from `'2024-11-05'` to `'2025-06-18'`

## Design Decisions

- **Version negotiation is opt-in**: The client sends its latest supported version (`2025-06-18`) and uses whatever the server responds with. If the server returns a different version (e.g., `2025-03-26`), subsequent requests use that version in the header.
- **Stdio transports get no-op stubs**: The `MCP-Protocol-Version` header is HTTP-only. The stdio transports implement `setProtocolVersion` as a no-op to satisfy the interface.
- **SSE parsing is minimal**: `parseSseResponse` only extracts the first JSON-RPC message with the matching id. It doesn't handle streaming responses for long-lived requests (not needed for the current usage pattern).
- **405 is terminal for GET**: Per the MCP 2025-06-18 spec, a 405 response to GET means the server doesn't offer an SSE stream. The client stops immediately rather than retrying.

## Files Changed

- `drone-agent/src/plugins/mcp/client.ts` — All transport changes
- `drone-agent/test/mcp-client.test.ts` — Updated existing test + 4 new tests
- `drone-agent/test/mcp-fake-server.ts` — Updated default protocol version

## Validation

- 39/39 MCP client tests pass (35 existing + 4 new)
- `pnpm -r run build` passes
- `pnpm lint` passes
- LSP diagnostics: clean
- Manual verification: GitHub Copilot MCP server connects successfully (47 tools discovered)

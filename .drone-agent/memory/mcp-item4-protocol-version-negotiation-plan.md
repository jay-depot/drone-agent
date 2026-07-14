---
key: mcp-item4-protocol-version-negotiation-plan
tags:
  - mcp
  - plan
  - protocol-version
  - github-mcp
created: 2026-07-14T01:23:37.590Z
updated: 2026-07-14T01:25:32.053Z
---

# Plan for MCP Client Gap Item 4: Protocol Version Negotiation

## Summary

The MCP streamable HTTP client has two problems that prevent it from connecting to the GitHub Copilot MCP server (`api.githubcopilot.com/mcp/`):

1. **Missing `MCP-Protocol-Version` HTTP header** — The MCP 2025-06-18 spec requires this header on **all** HTTP requests (POST, GET, DELETE). The client currently omits it entirely, causing the GitHub server to reject the `initialize` POST with 400.

2. **Hardcoded `protocolVersion: '2024-11-05'`** — The client sends an outdated protocol version in the `initialize` body. The GitHub server likely expects `'2025-06-18'` (the version that introduced the `MCP-Protocol-Version` header requirement).

## Spec Research (from modelcontextprotocol.io)

**MCP 2025-06-18 spec** (the version the GitHub server likely implements):

- The `MCP-Protocol-Version` HTTP header is **MANDATORY** on all requests: _"If using HTTP, the client MUST include the `MCP-Protocol-Version: <protocol-version>` HTTP header on all subsequent requests to the MCP server"_
- The client sends `protocolVersion` in the `initialize` body — this SHOULD be the latest version the client supports
- The server responds with its negotiated version
- The client MUST use the negotiated version in the header on all subsequent requests
- If the server receives an invalid/unsupported version, it MUST respond with 400
- For backwards compatibility, if the header is missing and the server can't infer the version, it SHOULD assume `2025-03-26`

**Draft spec (2026-07-28)** — even more changes (no GET stream, no sessions, new `Mcp-Method`/`Mcp-Name` headers, `_meta` field in body) — but this is draft, not yet released. We should target 2025-06-18.

## Files to modify

1. `drone-agent/src/plugins/mcp/client.ts` — the streamable HTTP transport
2. `drone-agent/test/mcp-client.test.ts` — fast unit tests
3. `drone-agent/test/mcp-fake-server.ts` — test mock (likely minimal changes)

## Detailed changes

### 1. `client.ts` — `createStreamableHttpJsonRpcClient` (line 521)

**Add state variable** after `let sessionId: string | undefined;`:

```typescript
let negotiatedProtocolVersion = '2025-06-18';
```

**Add `MCP-Protocol-Version` header to POST requests** (line ~640, inside the `request` function's headers object):

```typescript
'MCP-Protocol-Version': negotiatedProtocolVersion,
```

**Add `MCP-Protocol-Version` header to GET requests** (line ~540, inside `openGetStream`'s headers object):

```typescript
'MCP-Protocol-Version': negotiatedProtocolVersion,
```

**Add `MCP-Protocol-Version` header to DELETE requests** (line ~710, inside `disconnect`'s headers object):

```typescript
'MCP-Protocol-Version': negotiatedProtocolVersion,
```

**Expose a setter** so the caller can update the version after `initialize`:

```typescript
// Add to the returned JsonRpcClient object:
setProtocolVersion: (version: string) => {
  negotiatedProtocolVersion = version;
},
```

### 2. `client.ts` — `createMcpClientConnection` (line 1100)

**Update the main `initialize` body** to use `'2025-06-18'` instead of `'2024-11-05'`:

```typescript
await requestWithRetry(
  'initialize',
  {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {}, resources: {}, prompts: {} },
    clientInfo: { name: 'drone-agent', version: '0.1.0' },
  },
  false
);
```

**After the main `initialize` succeeds** (after line ~1126), extract the negotiated version from the server's response and pass it to the RPC client:

```typescript
const initResult = result as { protocolVersion?: string };
if (initResult.protocolVersion && initResult.protocolVersion !== '2025-06-18') {
  (rpc as { setProtocolVersion?: (v: string) => void }).setProtocolVersion?.(
    initResult.protocolVersion
  );
}
```

**Update the respawn monitor's initialize** (line ~1083) to also use `'2025-06-18'` and the stored version:

```typescript
await newRpc.request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {}, resources: {}, prompts: {} },
  clientInfo: { name: 'drone-agent', version: '0.1.0' },
});
// After success, extract and store the negotiated version
```

### 3. `mcp-fake-server.ts` — Update mock

The fake server's `initialize` handler currently returns `protocolVersion: '2024-11-05'` (line ~230). Update it to `'2025-06-18'` to match the new default.

The mock's `RequestRecord` type already captures `headers` (line ~130). No change needed there.

### 4. `mcp-client.test.ts` — Update tests

**Update existing test** "sends a single initialize with protocolVersion 2024-11-05..." (line ~120) to:

- Change the expected `protocolVersion` from `'2024-11-05'` to `'2025-06-18'`
- Add assertion: `expect(init!.headers['mcp-protocol-version']).toBe('2025-06-18');`

**Add test** "sends MCP-Protocol-Version header on subsequent POSTs":

- After `makeConnection`, call `conn.listTools()`
- Assert the `tools/list` request has `mcp-protocol-version` header

**Add test** "sends MCP-Protocol-Version header on GET SSE stream":

- After `makeConnection`, check the GET request has the header

**Add test** "sends MCP-Protocol-Version header on DELETE disconnect":

- After `makeConnection`, call `conn.disconnect()`
- Assert the DELETE request has the header

**Add test** "uses negotiated protocol version from server response":

- Create a mock that returns a different protocol version (e.g., `'2025-03-26'`)
- Assert subsequent requests use the negotiated version in the header

## Implementation order

1. Update `negotiatedProtocolVersion` default to `'2025-06-18'` and add `setProtocolVersion` to `createStreamableHttpJsonRpcClient`
2. Add the `MCP-Protocol-Version` header to POST, GET, and DELETE in the RPC client
3. Update the `initialize` body to use `'2025-06-18'` in both places (main + respawn monitor)
4. Extract negotiated version from initialize response and call `setProtocolVersion`
5. Update the fake server's default protocol version to `'2025-06-18'`
6. Update existing tests and add new tests
7. Run tests, build, lint

## Validation criteria

- All existing MCP client tests pass (35 tests in `drone-agent/test/mcp-client.test.ts`)
- New tests for the `MCP-Protocol-Version` header pass
- LSP diagnostics pass with zero errors
- `pnpm -r run build` passes
- `pnpm -r run lint` passes
- The GitHub MCP server at `api.githubcopilot.com/mcp/` accepts the initialize request (manual verification with a restart)

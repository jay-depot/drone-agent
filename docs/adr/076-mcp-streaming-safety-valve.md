---
tags: [decision, mcp, streaming, safety, sse]
related: [modules/drone-agent-mcp-client.md, decisions/074-mcp-spawn-timeout.md, decisions/075-mcp-tool-name-collisions.md]
---

# 076: SSE Streaming Safety Valve with Context-Aware Size Limit (Item 14)

**Status**: Implemented (2026-07-19)

## Context

Two issues with large/streaming MCP responses:

1. **SSE for all POST responses** — The code already checks `content-type` and uses `parseSseResponse` for any POST response, but `parseSseResponse` only extracted the first JSON-RPC message with a matching id. For long-running operations like `tools/call`, a server might send progress notifications before the final result.

2. **Context-aware safety valve** — `response.text()` reads the entire body into memory with no size limit. A malicious or buggy server could cause OOM.

## Decision

### 1. Multi-event SSE parsing

`parseSseResponse` now reads all SSE events from the stream, dispatches notification events (no `id`) to `onNotification`, and returns the first event with a matching `id` (the final result). Enforces a `maxSizeBytes` limit on total bytes read.

### 2. Chunked JSON body reading

Added `readResponseBody()` which reads a response body with a byte limit using `response.body.getReader()`, falling back to `response.text()` if no body stream is available.

### 3. Context-aware limit computation

The limit is computed in `index.ts` from the session's context window:

```typescript
const maxResponseSizeBytes = Math.max(
  1024 * 1024, // at least 1MB
  Math.round(sessionConfig.contextWindowTokens * 4 * 0.1)
);
```

- **10% of context window**: A rough heuristic. For a 32K context window, that's ~128KB (32K × 4 bytes/token × 0.1). For a 128K window, ~512KB. This scales naturally with the model's capacity.
- **1MB floor**: Even for small context windows, allow at least 1MB. This prevents overly aggressive limits on small models.
- **Chunked reading for both paths**: Using `response.body.getReader()` instead of `response.text()` lets us enforce the limit incrementally rather than reading the entire body first.
- **SSE progress notifications**: If a server sends progress updates before the final result, they're dispatched through the existing `onNotification` callback, which logs them. This is consistent with how the GET SSE stream works.

### Config schema

- `DroneMcpConfig.maxResponseSizeBytes` — global default (1048576 = 1MB)
- `DroneMcpStdioServerConfig.maxResponseSizeBytes?` — per-server override
- `DroneMcpStreamableHttpServerConfig.maxResponseSizeBytes?` — per-server override

## Consequences

- Progress notifications from long-running MCP operations are dispatched to `onNotification` before the final result is returned.
- Both SSE and JSON response paths enforce a byte limit, preventing OOM from large responses.
- The limit scales with the model's context window, keeping it proportional to available context.
- The transport layer stays pure — it just enforces whatever limit it's given. The plugin layer computes the limit from the session config.

## Files Changed

- `drone-core/src/config-types.ts` — Added `maxResponseSizeBytes` to `DroneMcpConfig`, `DroneMcpStdioServerConfig`, `DroneMcpStreamableHttpServerConfig`
- `drone-agent/src/plugins/mcp/client.ts` — Updated `parseSseResponse` for multi-event handling, added `readResponseBody`, added `maxResponseSizeBytes` to HTTP client options and `createMcpClientConnection`
- `drone-agent/src/plugins/mcp/index.ts` — Computes limit from session config, passes to `createMcpClientConnection`
- `drone-agent/test/mcp-client.test.ts` — 3 new tests: SSE progress notifications, SSE size limit exceeded, JSON size limit exceeded
- `drone-agent/test/mcp-fake-server.ts` — Added `postSseResponses` option, `okResponse` now provides a `ReadableStream` body, `sseResponse` supports result events

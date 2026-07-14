---
key: mcp-item14-streaming-safety-valve
tags:
  - mcp
  - item14
  - plan
created: 2026-07-14T04:17:24.725Z
updated: 2026-07-14T04:18:32.473Z
---

# Plan: SSE Streaming Support + Context-Aware Response Safety Valve (Item 14)

## Summary

Two things to address for large/streaming MCP responses:

1. **SSE for all POST responses** — The code already checks `content-type` and uses `parseSseResponse` for any POST response, but `parseSseResponse` only extracts the first JSON-RPC message with a matching id. For long-running operations like `tools/call`, a server might send progress notifications before the final result. The fix: make `parseSseResponse` handle multiple SSE events, collecting progress notifications and returning only the final result.

2. **Context-aware safety valve** — `response.text()` reads the entire body into memory with no size limit. Instead of a fixed config value, compute the limit dynamically from the session's context window (e.g., 10% of `contextWindowTokens`). This keeps the limit proportional to the available context and avoids OOM from a malicious or buggy server.

## MCP SSE streaming spec

When a server responds to a POST with `text/event-stream`, it sends one or more SSE events. Each event has a `data:` line containing a JSON-RPC message. The client should:
- Collect all events
- If an event has an `id` matching the request, it's the final result (or an error)
- If an event has no `id` (a notification), it's a progress update — the client can log it but should continue reading

## Steps

### Step 1: Update `parseSseResponse` to handle multiple events

Change `parseSseResponse` to:
- Read all SSE events from the stream
- Dispatch notification events (no `id`) to an `onNotification` callback
- Return the first event with a matching `id` (the final result)
- Enforce a `maxResponseSizeBytes` limit on total bytes read

```typescript
async function parseSseResponse(
  response: Response,
  id: number,
  onNotification: (method: string, params: unknown) => void,
  maxSizeBytes: number
): Promise<JsonRpcMessage> {
  if (!response.body) {
    throw new Error('SSE response has no body stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > maxSizeBytes) {
      reader.cancel();
      throw new Error(
        `MCP SSE response exceeded maximum size of ${maxSizeBytes} bytes`
      );
    }
    buffer += decoder.decode(value, { stream: true });
    // Process complete SSE events
    let separator: number;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const dataLine = rawEvent
        .split('\n')
        .find(line => line.startsWith('data:'));
      if (!dataLine) continue;
      const data = dataLine.slice('data:'.length).trim();
      if (data.length === 0) continue;
      try {
        const message = JSON.parse(data) as JsonRpcMessage;
        if (typeof message.id === 'number' && message.id === id) {
          return message; // Final result
        }
        if (typeof message.method === 'string') {
          onNotification(message.method, message.params); // Progress notification
        }
      } catch {
        // Ignore malformed SSE payloads
      }
    }
  }

  throw new Error('Invalid JSON payload from streamable HTTP MCP server.');
}
```

### Step 2: Add size limit to JSON response path in `client.ts`

For the non-SSE path (JSON responses), replace `response.text()` with a chunked read that enforces `maxResponseSizeBytes`:

```typescript
async function readResponseBody(
  response: Response,
  maxSizeBytes: number
): Promise<string> {
  if (!response.body) {
    return await response.text(); // fallback for environments without body
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > maxSizeBytes) {
      reader.cancel();
      throw new Error(
        `MCP response exceeded maximum size of ${maxSizeBytes} bytes`
      );
    }
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode(); // flush
  return result;
}
```

### Step 3: Add `maxResponseSizeBytes` parameter to `createMcpClientConnection`

Add `defaultMaxResponseSizeBytes` to the options. The transport layer doesn't know about context windows — it just enforces the limit it's given. The caller computes the limit.

### Step 4: Compute the limit in `index.ts` from session config

In `onPluginsLoaded`, compute the limit from the session's context window:

```typescript
const sessionConfig = registration.getConfig().session;
// Use 10% of the context window as a rough byte limit
// (1 token ≈ 4 bytes for UTF-8, so contextWindowTokens * 4 * 0.1)
const maxResponseSizeBytes = Math.max(
  1024 * 1024, // at least 1MB
  Math.round(sessionConfig.contextWindowTokens * 4 * 0.1)
);
```

Pass it to `createMcpClientConnection` as `defaultMaxResponseSizeBytes`.

### Step 5: Wire `parseSseResponse` and `readResponseBody` into the POST handler

In `createStreamableHttpJsonRpcClient`'s `request` method:
- Pass `onNotification` and `maxSizeBytes` to `parseSseResponse`
- Use `readResponseBody` instead of `response.text()` for the JSON path

### Step 6: Add tests

In `mcp-client.test.ts`:
- Add a test that verifies a response exceeding the size limit throws an error
- Add a test that verifies SSE responses with progress notifications are dispatched to `onNotification` before the final result

### Step 7: Verify build, lint, and tests pass

## Design Decisions

- **Limit computed in `index.ts`, enforced in `client.ts`**: The transport layer stays pure — it just enforces whatever limit it's given. The plugin layer computes the limit from the session config, keeping the context-awareness in the right place.
- **10% of context window**: A rough heuristic. For a 32K context window, that's ~128KB (32K × 4 bytes/token × 0.1). For a 128K window, ~512KB. This scales naturally with the model's capacity.
- **1MB floor**: Even for small context windows, allow at least 1MB. This prevents overly aggressive limits on small models.
- **Chunked reading for both paths**: Using `response.body.getReader()` instead of `response.text()` lets us enforce the limit incrementally rather than reading the entire body first.
- **SSE progress notifications**: If a server sends progress updates before the final result, they're dispatched through the existing `onNotification` callback, which logs them. This is consistent with how the GET SSE stream works.

## Validation Criteria

- [ ] `parseSseResponse` handles multiple SSE events, dispatching notifications and returning the final result
- [ ] `readResponseBody` enforces a byte limit via chunked reading
- [ ] JSON response path uses `readResponseBody` instead of `response.text()`
- [ ] SSE response path enforces the byte limit
- [ ] Limit is computed from session context window in `index.ts` (10% of contextWindowTokens × 4, min 1MB)
- [ ] All existing tests pass
- [ ] LSP diagnostics pass
- [ ] `pnpm -r run build` passes
- [ ] `pnpm -r run lint` passes
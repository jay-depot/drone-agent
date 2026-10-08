---
tags: [decision, mcp, spawn, timeout]
related:
  [
    modules/drone-agent-mcp-client.md,
    decisions/075-mcp-tool-name-collisions.md,
    decisions/076-mcp-streaming-safety-valve.md,
  ]
---

# 074: MCP Spawn Timeout (Item 12)

**Status**: Implemented (2026-07-19)

## Context

The MCP client used a single `requestTimeoutMs` for everything — both individual JSON-RPC requests and the `initialize` handshake after spawning a child process. Spawning a process can take significantly longer than a single request (e.g., a server that downloads a model on first launch), and you might want different timeouts for each.

## Decision

Add a separate `spawnTimeoutMs` config field and use it for the `initialize` call during spawn/respawn, while keeping `requestTimeoutMs` for subsequent JSON-RPC calls.

### Implementation

The implementation uses a **runtime-mutable timeout** approach:

- **`JsonRpcClient` type** gained an optional `setRequestTimeout?(ms: number)` method.
- **HTTP transport**: the streamable HTTP client captures `requestTimeoutMs` in a closure variable that `setRequestTimeout` mutates. Before `initialize`, the client calls `setRequestTimeout(effectiveSpawnTimeoutMs)`; after `initialize` succeeds, it calls `setRequestTimeout(effectiveRequestTimeoutMs)` to shrink back to the runtime value. The same client instance is retained (preserving `sessionId` + negotiated protocol version).
- **stdio transport**: the stdio client captures `requestTimeoutMs` at construction. The initial client is created with `effectiveSpawnTimeoutMs`, and after `initialize` succeeds, a new stdio client is built with `effectiveRequestTimeoutMs` (same child process transport).
- **Respawn monitor** creates its replacement stdio RPC client with `effectiveSpawnTimeoutMs` and calls `initialize` directly (not via `requestWithRetry`).

### Config schema

- `DroneMcpConfig.spawnTimeoutMs` — global default (30000ms)
- `DroneMcpStdioServerConfig.spawnTimeoutMs?` — per-server override

### Test infrastructure fix

The `mcp-fake-server.ts` mock had a latent bug: `handle()` was synchronous and did not `await` Promise-returning handlers. This caused async test handlers (used by the new spawnTimeoutMs tests) to silently return unresolved Promises, which `JSON.stringify` serialized as empty/undefined results — so the tests saw `[]` instead of timing out. Fixed by making `handle()` async and awaiting handler results. Also added proper `AbortSignal` support to `fetchCore` so the timeout path (via `AbortController`) actually rejects with an `AbortError`, matching real `fetch` behavior.

## Consequences

- Spawning slow-to-initialize MCP servers no longer times out when `requestTimeoutMs` is short.
- Subsequent JSON-RPC calls still use the shorter `requestTimeoutMs`, so a slow response after initialization is still caught quickly.
- The HTTP transport's `setRequestTimeout` approach avoids creating a second RPC client (preserving session state), while the stdio transport rebuilds the client (since the timeout is captured in closures at construction time).

## Files Changed

- `drone-core/src/config-types.ts` — Added `spawnTimeoutMs` to `DroneMcpConfig` and `DroneMcpStdioServerConfig`
- `drone-agent/src/plugins/mcp/client.ts` — Added `setRequestTimeout` to `JsonRpcClient`, `defaultSpawnTimeoutMs` to `createMcpClientConnection`, runtime timeout mutation for HTTP, client rebuild for stdio, spawn timeout in respawn monitor
- `drone-agent/src/plugins/mcp/index.ts` — Wired `defaultSpawnTimeoutMs` from config
- `drone-agent/test/mcp-client.test.ts` — 3 new tests: spawn timeout used for initialize, short spawn timeout times out, subsequent requests use request timeout
- `drone-agent/test/mcp-fake-server.ts` — Fixed async handler dispatch, added AbortSignal support

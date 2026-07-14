---
key: mcp-item12-spawn-timeout
tags:
  - mcp
  - item12
  - plan
created: 2026-07-14T04:09:25.785Z
updated: 2026-07-14T04:09:25.785Z
---

# Plan: MCP Spawn Timeout (Item 12)

## Summary

Currently `requestTimeoutMs` is used for everything — both individual JSON-RPC requests and the `initialize` handshake after spawning a child process. Spawning a process can take significantly longer than a single request, and you might want different timeouts for each. The fix: add a `spawnTimeoutMs` config field and use it for the `initialize` call during spawn/respawn, while keeping `requestTimeoutMs` for subsequent JSON-RPC calls.

## Steps

### Step 1: Add `spawnTimeoutMs` to config types in `drone-core/src/config-types.ts`

Add to `DroneMcpConfig` (global default) and `DroneMcpStdioServerConfig` (per-server override):

```typescript
export type DroneMcpConfig = {
  // ... existing fields ...
  spawnTimeoutMs: number; // default: 30000
};

export type DroneMcpStdioServerConfig = {
  // ... existing fields ...
  spawnTimeoutMs?: number; // per-server override
};
```

Update the default in the `DEFAULT_CONFIG` section:

```typescript
mcp: {
  // ... existing defaults ...
  spawnTimeoutMs: 30000,
}
```

### Step 2: Thread `spawnTimeoutMs` through `createMcpClientConnection` in `client.ts`

Add `defaultSpawnTimeoutMs` to the options parameter. Compute `effectiveSpawnTimeoutMs` from the per-server config override or the default.

### Step 3: Use `spawnTimeoutMs` for `initialize` calls

In the main `initialize` call (line ~1185), the `requestWithRetry` uses `effectiveRequestTimeoutMs` internally. Since `requestWithRetry` creates a new `JsonRpcClient` request each time, and the `JsonRpcClient`'s `requestTimeoutMs` is set at construction time, the simplest approach is:

- Create a **separate `JsonRpcClient`** for the spawn/initialize phase with `requestTimeoutMs` set to `effectiveSpawnTimeoutMs`
- Or, more practically: pass `effectiveSpawnTimeoutMs` as the timeout for the `initialize` request specifically. Since `requestWithRetry` calls `rpc.request()`, and the timeout is baked into the `JsonRpcClient` at construction, we need to either:
  a. Create a temporary RPC client for the initialize phase with the spawn timeout, then swap to the real one
  b. Or add a per-request timeout override to the `request` method

Option (a) is simpler — create the transport, create a temporary RPC client with `spawnTimeoutMs`, do `initialize`, then create the real RPC client with `requestTimeoutMs` for ongoing use.

Actually, looking at the code more carefully: the `JsonRpcClient` is created before `initialize` and used for all subsequent requests. The cleanest approach is to just pass `effectiveSpawnTimeoutMs` as the `requestTimeoutMs` for the initial RPC client, then after `initialize` succeeds, create a new RPC client with `effectiveRequestTimeoutMs` for ongoing use. But that's wasteful.

Simplest approach: **just use `effectiveSpawnTimeoutMs` for the `initialize` call** by passing it as the timeout to `requestWithRetry` (which already accepts a timeout via the underlying `rpc.request`). Since `rpc.request` uses `options.requestTimeoutMs` set at construction, we can either:

1. Create the RPC client with `spawnTimeoutMs`, then after initialize, update the timeout (but the timeout is captured in closures)
2. Create a second RPC client after initialize with the shorter timeout

**Recommended approach**: Create the RPC client with `effectiveSpawnTimeoutMs` for the initial handshake. After `initialize` succeeds, create a new RPC client with `effectiveRequestTimeoutMs` and swap it in. This is clean and doesn't require changing the `JsonRpcClient` interface.

### Step 4: Use `spawnTimeoutMs` in the respawn monitor

In `startRespawnMonitor`, the same pattern applies — use `effectiveSpawnTimeoutMs` for the `initialize` call in the respawn path.

### Step 5: Wire `spawnTimeoutMs` from plugin registration in `index.ts`

Add `defaultSpawnTimeoutMs: mcpConfig.spawnTimeoutMs` to the `createMcpClientConnection` call.

### Step 6: Add tests

In `mcp-client.test.ts`:

- Add a test that verifies `spawnTimeoutMs` is used for the `initialize` request (e.g., by setting a very short spawn timeout and verifying the initialize fails with a timeout)

### Step 7: Verify build, lint, and tests pass

## Validation Criteria

- [ ] `spawnTimeoutMs` config field exists in `DroneMcpConfig` and `DroneMcpStdioServerConfig`
- [ ] `initialize` uses `spawnTimeoutMs` instead of `requestTimeoutMs`
- [ ] Subsequent JSON-RPC requests still use `requestTimeoutMs`
- [ ] Respawn monitor uses `spawnTimeoutMs` for its `initialize` call
- [ ] All existing tests pass
- [ ] LSP diagnostics pass
- [ ] `pnpm -r run build` passes
- [ ] `pnpm -r run lint` passes

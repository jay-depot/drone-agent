---
key: mcp-item10-roots-capability
tags:
  - mcp
  - item10
  - plan
created: 2026-07-14T03:41:11.308Z
updated: 2026-07-14T03:41:11.308Z
---

# Plan: MCP Roots Capability (Item 10)

## Summary

The MCP client's `initialize` doesn't advertise `roots`, so servers that want to know the client's filesystem roots (e.g., for resolving relative paths or scoping file operations) have no way to discover them. The fix: add a `roots` config section, advertise `roots` in capabilities, and implement a `roots/list` handler that the server can call.

## MCP `roots` spec

The `roots` capability is a **client capability** — the client advertises it in `initialize`, and the server can call `roots/list` as a **client-to-server request** (the server sends a request with an `id`, and the client must respond).

Each root has:
- `uri` (required) — a URI, typically `file:///path/to/dir`
- `name` (optional) — a human-readable label

The `roots/list` response shape:
```typescript
{
  roots: Array<{ uri: string; name?: string }>;
}
```

## Design

### Default roots (always present, computed at runtime)
- The CWD (project directory) — `file://<cwd>`, name: `"Project Root"`
- The user's home directory — `file://<home>`, name: `"Home Directory"`

### Config overrides (additive)
- `mcp.roots` in project-level config adds more roots
- `mcp.roots` in user-level config adds more roots
- These merge with the defaults (no dedup — duplicates are fine, the server can handle them)

### Config shape
```typescript
// In DroneMcpConfig
roots?: Array<{ uri: string; name?: string }>;
```

## Steps

### Step 1: Add `roots` to `DroneMcpConfig` in `drone-core/src/config-types.ts`

Add an optional `roots` field to `DroneMcpConfig`:
```typescript
export type DroneMcpRoot = {
  uri: string;
  name?: string;
};

export type DroneMcpConfig = {
  // ... existing fields ...
  roots?: DroneMcpRoot[];
};
```

### Step 2: Add `onRequest` callback to transport layer in `client.ts`

The transport layer currently handles two message types:
1. **Client→Server requests** (messages with `id` that match a pending request) — resolved/rejected
2. **Server→Client notifications** (messages with `method` but no `id`) — dispatched to `onNotification`

For `roots/list`, we need to handle **Server→Client requests** — messages with an `id` and `method` that don't match any pending request. These need to be dispatched to an `onRequest` callback that can respond.

Changes:
- Add `onRequest?: (method: string, params: unknown) => Promise<unknown>` to the `JsonRpcClient` interface
- In the SSE stream reader (`openGetStream`), when a message has an `id` and `method` but no matching pending entry, call `onRequest` and send the response back through the transport
- In the stdio framing parsers (`createContentLengthJsonRpcClient`, `createLineDelimitedJsonRpcClient`), same logic: when a message has an `id` and `method` but no matching pending entry, call `onRequest` and send the response back through the transport

### Step 3: Implement `roots/list` handler in `client.ts`

Add a `roots` parameter to `createMcpClientConnection` options:
```typescript
roots?: Array<{ uri: string; name?: string }>;
```

Wire it into the `onRequest` callback so that when the server calls `roots/list`, the client responds with the configured roots.

### Step 4: Wire roots from plugin registration in `index.ts`

In `onPluginsLoaded`, compute the default roots (CWD + home) and merge with config roots. Pass them to `createMcpClientConnection`.

### Step 5: Advertise `roots` in `initialize` capabilities

Add `roots: {}` to the capabilities object in both `initialize` calls (main + respawn monitor).

### Step 6: Add tests

In `mcp-client.test.ts`:
- Add a test that verifies the `initialize` capabilities include `roots: {}`
- Add a test that verifies `roots/list` returns the configured roots

### Step 7: Verify build, lint, and tests pass

## Design Decisions

- **How to respond to server→client requests**: The simplest approach is to handle `roots/list` synchronously in the `onRequest` callback and send the response back through the transport's `write` method. The transport layer already has the ability to write messages — we just need to expose it.
- **No config schema change for defaults**: The CWD and home directory are computed at runtime, not stored in config. Only additional roots go in config.
- **`roots` is optional**: If no roots are configured and the defaults can't be determined, the capability is still advertised but `roots/list` returns an empty array.

## Validation Criteria

- [ ] `initialize` advertises `roots: {}` in capabilities
- [ ] `roots/list` returns the configured roots (defaults + config overrides)
- [ ] Transport layer handles server→client requests via `onRequest` callback
- [ ] All existing tests pass
- [ ] LSP diagnostics pass
- [ ] `pnpm -r run build` passes
- [ ] `pnpm -r run lint` passes
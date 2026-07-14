---
key: mcp-item7-logging-capability
tags:
  []
created: 2026-07-14T03:30:46.760Z
updated: 2026-07-14T19:06:10.681Z
---

# Plan: MCP Logging Capability (Item 7)

## Summary

The MCP client's `initialize` only advertises `{ tools: {}, resources: {}, prompts: {} }` — it doesn't advertise `logging`. This means servers that want to send log messages via `notifications/message` have no indication the client supports it. Additionally, the `onNotification` callback in `index.ts` receives `notifications/message` events but only logs the method name at `info` level, ignoring the actual log content and level.

The fix: advertise `logging` in capabilities, and handle `notifications/message` by dispatching to the plugin's logger at the appropriate level.

## MCP `notifications/message` spec

The notification params have the shape:

```typescript
{
  level: 'debug' | 'info' | 'warning' | 'error';
  logger?: string;       // Optional logger name
  data: unknown;         // The log data (typically a string or object)
}
```

## Steps

### Step 1: Add `logging` to `initialize` capabilities in `client.ts`

In `createMcpClientConnection`, add `logging: {}` to the capabilities object in both places:

- The main `initialize` call (line ~1190)
- The respawn monitor's `initialize` call (line ~1161)

### Step 2: Handle `notifications/message` in `index.ts`

Update the `onNotification` callback to handle `notifications/message` by parsing the params and dispatching to the logger at the appropriate level. The MCP `level` field maps to `DroneLogger` methods:

- `debug` → `info` (DroneLogger has no `debug`)
- `info` → `info`
- `warning` → `warn`
- `error` → `error`

The log message should include the logger name (if present) and the data content.

### Step 3: Add tests

In `mcp-client.test.ts`:

- Add a test that verifies the `initialize` capabilities include `logging: {}`
- Add a test that verifies `notifications/message` is dispatched to the logger with the correct level and content

### Step 4: Verify build, lint, and tests pass

Run `pnpm build`, `pnpm -r run lint`, and `pnpm -r run test` to confirm everything passes.

## Validation Criteria

- [x] `initialize` advertises `logging: {}` in capabilities
- [x] `notifications/message` is handled by dispatching to the logger at the correct level
- [x] All existing tests pass
- [x] LSP diagnostics pass
- [x] `pnpm -r run build` passes
- [x] `pnpm -r run lint` passes

## Work Completed (2026-07-14)

- Added `logging: {}` to both `initialize` calls in `client.ts` (main handshake and respawn monitor)
- Updated `onNotification` in `index.ts` to handle `notifications/message` with level-based dispatch to `DroneLogger` (debug/info → info, warning → warn, error → error), including logger name and data content
- Updated `mcp-client.test.ts` to expect `logging: {}` in capabilities and added SSE test verifying `notifications/message` params pass through
- Extended `mcp-fake-server.ts` with `notifyMessageOnToolName` option and `FakeMcpServerOptions` type
- Extended `mcp-fake-server.mjs` to send `notifications/message` when a configured tool is called
- Added integration test in `mcp.test.ts` for `notifications/message` dispatch via stdio transport
- All changes committed to branch `mcp-item7-logging-capability`
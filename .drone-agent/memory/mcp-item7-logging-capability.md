---
key: mcp-item7-logging-capability
tags:
  - mcp
  - item7
  - plan
created: 2026-07-14T03:30:46.760Z
updated: 2026-07-14T03:30:46.760Z
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

- [ ] `initialize` advertises `logging: {}` in capabilities
- [ ] `notifications/message` is handled by dispatching to the logger at the correct level
- [ ] All existing tests pass
- [ ] LSP diagnostics pass
- [ ] `pnpm -r run build` passes
- [ ] `pnpm -r run lint` passes

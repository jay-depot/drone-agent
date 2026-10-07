---
tags: [decision, mcp, logging]
related: [modules/drone-agent-mcp-client.md, decisions/064-mcp-deferred-tool-loading.md]
---

# 070: MCP Logging Capability (Item 7)

**Status**: Implemented (2026-07-14)

## Context

The MCP client's `initialize` only advertised `{ tools: {}, resources: {}, prompts: {} }` — it did not advertise `logging`. This meant servers that wanted to send log messages via `notifications/message` had no indication the client supported receiving them. Additionally, the `onNotification` callback in `index.ts` received `notifications/message` events but only logged the method name at `info` level, ignoring the actual log content and level.

The MCP `notifications/message` spec defines params with the shape:

```typescript
{
  level: 'debug' | 'info' | 'warning' | 'error';
  logger?: string;       // Optional logger name
  data: unknown;         // The log data (typically a string or object)
}
```

## Decision

1. **Advertise `logging: {}`** in the `initialize` capabilities object in both the main handshake and the respawn monitor's re-initialize call in `client.ts`.

2. **Handle `notifications/message`** in the `onNotification` callback in `index.ts` by parsing the params and dispatching to the plugin's `DroneLogger` at the appropriate level:
   - `debug` → `info` (DroneLogger has no `debug` method)
   - `info` → `info`
   - `warning` → `warn`
   - `error` → `error`

3. **Include context in log messages**: The log message format is `mcp server ${serverId} log${loggerName}: ${dataStr}`, where `loggerName` is ` [${logger}]` when present, and `dataStr` is the stringified data content.

## Consequences

- MCP servers that check the client's `logging` capability will now see it advertised and may send `notifications/message` events.
- Log messages from MCP servers are now dispatched at the correct severity level, making them visible in the agent's log output at the appropriate verbosity.
- The change is minimal (no new dependencies, no config changes) — just a capabilities flag and a notification handler update.
- Backward compatible: servers that don't send `notifications/message` are unaffected.

## Files Changed

- `drone-agent/src/plugins/mcp/client.ts` — Added `logging: {}` to both `initialize` calls
- `drone-agent/src/plugins/mcp/index.ts` — Updated `onNotification` to handle `notifications/message`
- `drone-agent/test/mcp-client.test.ts` — Updated capabilities assertion; added SSE test for `notifications/message` params passthrough
- `drone-agent/test/mcp-fake-server.ts` — Added `notifyMessageOnToolName` option
- `drone-agent/test/mcp-fake-server.mjs` — Added `notifications/message` sending on configured tool call
- `drone-agent/test/mcp.test.ts` — Added integration test for `notifications/message` dispatch via stdio

---
key: mcp-client-gaps
tags:
  - mcp
  - gaps
  - testing
  - planning
  - completed
created: 2026-07-07T17:29:50.826Z
updated: 2026-07-20T00:34:56.164Z
---

# MCP Client Gap Analysis (2026-07-07, updated 2026-07-19 — ALL ITEMS COMPLETE)

Source files: `drone-agent/src/plugins/mcp/index.ts`, `client.ts`; `drone-core/src/mcp-types.ts`, `config-types.ts`.
Tests: `drone-agent/test/mcp-client.test.ts` (fast, in-process `fetch` mock via `mcp-fake-server.ts`) and `mcp.test.ts` + `mcp-fake-server.mjs` (slow stdio integration).

## Status: ALL ITEMS COMPLETE

All 14 actionable items from the original gap analysis have been implemented and verified. The only remaining item (#11, `completion/complete`) was intentionally marked WON'T DO.

## Item status

| # | Description | Status | PR/Commit |
|---|-------------|--------|-----------|
| 1 | Streamable HTTP ignores `Mcp-Session-Id` header | ✅ DONE | `418b400` |
| 2 | No `tools/call` `isError` handling | ✅ DONE | `418b400` |
| 3 | Tests exist | ✅ DONE | `418b400` |
| 4 | Hardcoded `protocolVersion` | ✅ DONE | `20fce35` |
| 5 | No resource templates | ✅ DONE | `mcp-resource-templates-plan` |
| 6 | No `notifications/tools/list_changed` handling | ✅ DONE | `0943ac8` |
| 7 | No notification/progress/log handling; no `logging`/`roots` in initialize | ✅ DONE | `50228b6` (logging), `020a13f` (roots) |
| 8 | HTTP transport is single-POST only | ✅ DONE | `f4846ac` |
| 9 | `discoveredToolCount` set to truncated count | ✅ DONE | `db9137c` |
| 10 | No `roots` capability | ✅ DONE | `020a13f` |
| 11 | No `completion/complete` | ⏭️ WON'T DO | Not useful for LLM agents |
| 12 | No spawn-timeout separate from request-timeout | ✅ DONE | `055c1ca` (#21) |
| 13 | Tool-name sanitization collisions silently skipped | ✅ DONE | `055c1ca` (#21) |
| 14 | No streaming / partial-content for large results | ✅ DONE | `055c1ca` (#21) |
| 15 | Auto-reconnect GET SSE stream | ✅ DONE | `f4846ac` |
| 16 | Respawn crashed stdio servers | ✅ DONE | `f4846ac` |

## Implementation details

### Items 1 & 2 — Session-Id + isError (Phase 1 baseline fix)
Runtime-only `Mcp-Session-Id` capture/echo in `createStreamableHttpJsonRpcClient` (`client.ts` — `let sessionId` persists and is sent as `mcp-session-id` header). `callTool` throws on `isError: true`, surfaced by `executeToolSafely` as a real `{kind:'error'}` tool result.

### Item 4 — Protocol version negotiation
Default `protocolVersion` changed from `'2024-11-05'` to `'2025-06-18'` in both main initialize and respawn monitor. `MCP-Protocol-Version` HTTP header sent on all POST, GET, and DELETE requests. `setProtocolVersion` on `JsonRpcClient` interface. Negotiated version extracted from server's `initialize` response and applied to subsequent requests.

### Item 5 — Resource templates
`DroneMcpResourceTemplateMeta` + `resourceTemplatesListTruncated?` in drone-core. `normalizeResourceTemplates()` + `listResourceTemplates()` in client (`resources/templates/list`, reusing `paginateList`). Dedicated `${serverId}__list_resource_templates` tool. Templates read through shared `resources/read` (no separate read tool needed per spec).

### Item 6 — tools/list_changed handling
`onNotification` callback handles `notifications/tools/list_changed` and triggers surgical re-list + stale-tool unmount via `handleToolsListChanged`. Uses `unregisterTool` for single-tool removal. Does NOT nuke all MCP plugin tools across all servers.

### Item 7 — Logging + roots capabilities
`initialize` advertises `logging: {}` and `roots: {}` in capabilities. `notifications/message` dispatched to plugin logger at appropriate severity level. `roots/list` server→client requests handled via `onRequest` transport callback with default roots (CWD + home) + config overrides.

### Item 8 — GET SSE stream + DELETE
Streamable-HTTP transport opens a GET SSE reader after `initialize` and dispatches server→client notifications through `onNotification` callback. Best-effort `DELETE` (with `mcp-session-id`) on `disconnect`. `DroneMcpServerState` gained `streaming?` / `lastStreamError?`.

### Item 9 — walkAllPages for tools
`listTools` uses `walkAllPages` (separate from `paginateList`) which fetches all pages without `maxListPages`/`maxListItems` caps — only infinite-loop protection via cursor dedup. `discoveredToolCount` reflects true server total; `toolsListTruncated` is always `false` for tools.

### Item 10 — Roots capability
`roots: {}` advertised in initialize. `roots/list` server→client requests handled via `onRequest` transport callback. Default roots: `file://<cwd>` (Project Root) + `file://<home>` (Home Directory), merged with `mcp.roots` config.

### Item 12 — Spawn timeout
`spawnTimeoutMs` config field (default 30s) for the `initialize` handshake, separate from `requestTimeoutMs` for subsequent JSON-RPC calls. HTTP transport uses runtime-mutable timeout via `setRequestTimeout()`; stdio transport rebuilds the RPC client after initialize. Respawn monitor also uses spawn timeout.

### Item 13 — Tool-name collisions
`sanitizeToolSegment` detects collisions and appends `_1`, `_2`, etc. (e.g., `foo bar` and `foo.bar` → `foo_bar` and `foo_bar_1`). Per-server `usedNames` sets stored in `serverUsedNames` map. `ToolMountingCache.getToolDefName()` so meta-tool handlers report the actual registered name.

### Item 14 — Streaming safety valve
`parseSseResponse` handles multiple SSE events, dispatching progress notifications via `onNotification` and returning only the final result. `readResponseBody()` for chunked reading with byte limit enforcement. `maxResponseSizeBytes` config (default 1MB), computed from session context window (10% of `contextWindowTokens * 4`, min 1MB).

### Items 15 & 16 — SSE reconnect + stdio respawn
GET SSE stream auto-reconnects on transient drops with exponential backoff (1s → 2s → 4s → ... → 60s cap). Crashed stdio servers are automatically respawned with exponential backoff, re-initialized, and tools re-mounted via `onReconnected` callback.

## Test coverage
- **Fast suite** (`mcp-client.test.ts`): 49 tests covering all HTTP transport features including session-id, isError, protocol negotiation, resource templates, pagination, retry, error classification, compatibility modes, roots, SSE stream, DELETE, spawn timeout, size limits, and progress notifications.
- **Slow suite** (`mcp.test.ts`): 16 tests covering stdio child lifecycle (shutdown, force-kill, error states, respawn, tools/list_changed, notifications/message, multi-server, tool-name sanitization, collision disambiguation).
- **Total**: 1477 tests across all packages (98 files), all passing.
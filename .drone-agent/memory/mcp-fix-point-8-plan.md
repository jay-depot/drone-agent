---
key: mcp-fix-point-8-plan
tags:
  - mcp
  - gaps
  - planning
  - point-8
created: 2026-07-08T05:26:45.407Z
updated: 2026-07-08T05:43:25.405Z
---

# Plan: MCP Streamable-HTTP — GET SSE Stream + DELETE Termination (point 8)

## Status: COMPLETE (2026-07-08)
All 9 steps implemented and verified. Build, typecheck, lint, full test suite (1270 tests) green; LSP diagnostics clean (hints only, no errors/warnings).

## Summary
The streamable-HTTP MCP transport in `drone-agent/src/plugins/mcp/client.ts` (`createStreamableHttpJsonRpcClient`) was request/response POST only. It (a) never opened the server→client GET SSE stream used to deliver notifications, and (b) `disconnect` was a synchronous no-op that just flipped `closed`. Fixed: added a GET SSE reader that dispatches received notifications through a new callback hook, and a best-effort `DELETE` on disconnect.

## What shipped
- `drone-core/src/mcp-types.ts`: `DroneMcpServerState` gains `streaming?` + `lastStreamError?`.
- `client.ts` `createStreamableHttpJsonRpcClient`: accepts `onNotification`/`onStreamError`; `openGetStream()` opens GET `text/event-stream`, decodes SSE `data:` blocks, dispatches `onNotification(method, params)`; on AbortError returns silently, else `onStreamError`. `disconnect` now `streamAbort.abort()`s the reader then fire-and-forget `DELETE` (with `mcp-session-id`) — non-blocking, `.then/.catch` logs via `onStreamError`, never throws. Added `startNotifications?: () => void` to `JsonRpcClient`.
- `client.ts` `createMcpClientConnection`: accepts + forwards `onNotification`/`onStreamError`; after `initialize`, for HTTP calls `rpc.startNotifications?.()` and sets `state.streaming = true`.
- `index.ts` `onPluginsLoaded`: declares `connection`, `onNotification` (logs), `onStreamError` (logs + sets `streaming=false`/`lastStreamError` on state) and passes them in. `onNotification` is the item-6 hook point (NOT wired to re-mount yet).
- `mcp-fake-server.ts`: `sseEvents`/`sseError` options; GET returns a real `ReadableStream` SSE response; DELETE returns 204 (or `httpErrors['DELETE']`). Mock records HTTP verb for GET/DELETE (no body). `sseError` defers the error to a macrotask for deterministic tests.
- `mcp-client.test.ts`: 6 new tests — GET headers, `tools/list_changed` dispatch, multi-event dispatch, stream-error log-and-stop (status stays `connected`), `DELETE` on disconnect, best-effort `DELETE` failure (no throw).

## Discovered during implementation (review notes)
- The mock must record the HTTP verb for GET/DELETE (they have no JSON body), not just the JSON-RPC `method`.
- Client `DELETE` must check `response.ok` (not just `.catch`) since the mock returns a non-ok resolved `Response` for failures.
- Fire-and-forget GET reader can error before the caller assigns its connection handle; `index.ts` uses a holder declared before the loop (and tests mirror this with a `captured` holder) with an `if (conn)` guard.

## Scope boundaries (deliberately NOT in this plan)
- Re-mounting tools on `tools/list_changed` -> item 6.
- Auto-reconnect of the SSE stream -> item 15.
- Respawning crashed stdio servers -> item 16.
- Sending `notifications/initialized` over HTTP / advertising `logging`+`roots` -> item 7.
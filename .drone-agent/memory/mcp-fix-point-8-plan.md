---
key: mcp-fix-point-8-plan
tags:
  - mcp
  - gaps
  - planning
  - point-8
created: 2026-07-08T05:26:45.407Z
updated: 2026-07-08T05:26:45.407Z
---

# Plan: MCP Streamable-HTTP — GET SSE Stream + DELETE Termination (point 8)

## Summary
The streamable-HTTP MCP transport in `drone-agent/src/plugins/mcp/client.ts` (`createStreamableHttpJsonRpcClient`, lines ~500–616) is request/response POST only. It (a) never opens the server→client GET SSE stream used to deliver notifications, and (b) `disconnect` is a synchronous no-op that just flips `closed`. This plan adds a GET SSE reader that dispatches received notifications through a new callback hook, and a best-effort `DELETE` on disconnect.

## Why
- Without the GET stream, the agent can never receive `notifications/tools/list_changed`, log/progress messages, or any server-initiated signal (tools go stale, server has no channel to client).
- Without `DELETE`, sessions leak server-side and spec-compliant servers may reject reconnection. (item 8 of `mcp-client-gaps`.)

## Scope decisions (confirmed with user)
1. Both halves together — 8a (DELETE) + 8b (GET SSE stream).
2. 8b depth = transport + dispatch hook. Mirror the LSP plugin's `onNotification` pattern. Log received notifications for observability. Tests assert the hook fires (incl. `tools/list_changed`) but NO re-mount logic (that's item 6).
3. SSE resilience now = log-and-stop. Auto-reconnect -> new item 15; crashed-stdio respawn -> new item 16 (deferred).
4. `disconnect` (HTTP): abort GET reader -> best-effort `DELETE` to `options.url` with `mcp-session-id` header -> flip `closed`. DELETE failure logged + continued; `state.status` still `'disconnected'` (no flip to `'error'`).

## Files touched
- `drone-core/src/mcp-types.ts` — add `streaming?`, `lastStreamError?` to `DroneMcpServerState`
- `drone-agent/src/plugins/mcp/client.ts` — GET SSE reader + DELETE in HTTP client; `JsonRpcClient` type + `createMcpClientConnection` wiring
- `drone-agent/src/plugins/mcp/index.ts` — pass `onNotification`/`onStreamError`
- `drone-agent/test/mcp-fake-server.ts` — mock GET SSE stream + DELETE
- `drone-agent/test/mcp-client.test.ts` — new tests

## Steps
1. coder — `drone-core/src/mcp-types.ts`: add `streaming?: boolean; lastStreamError?: string;` to `DroneMcpServerState`. Run `pnpm build`.
2. coder — `createStreamableHttpJsonRpcClient`: add `onNotification` + `onStreamError` options; add `streamAbort = new AbortController()`; add internal `openGetStream()` (GET with `accept: text/event-stream` + session id, read `response.body`, decode SSE `data:` blocks, dispatch `onNotification(method, params)`; on AbortError return silently; on error call `onStreamError` and stop — no reconnect). Replace `disconnect` to set `closed`, `streamAbort.abort()`, fire-and-forget `DELETE` to `options.url` with session id header (`.catch(e => onStreamError(...))`). Add `startNotifications: () => void` to returned object. Keep `notify` no-op (item 7).
3. coder — `JsonRpcClient` type: add optional `startNotifications?: () => void;`.
4. coder — `createMcpClientConnection`: accept `onNotification`/`onStreamError`; forward to HTTP client; after successful initialize handshake, if HTTP, call `rpc.startNotifications?.()` and set `state.streaming = true`.
5. coder — `index.ts` `onPluginsLoaded`: declare `let connection`; define `onNotification` (logger.info) and `onStreamError` (logger.warn + set `connection.state.streaming=false`, `lastStreamError`, `setServerState`); pass into `createMcpClientConnection`. This is the ready hook for item 6 (`tools/list_changed` re-mount).
6. coder+tester — `mcp-fake-server.ts`: add `sseEvents?` + `sseError?` to `MockFetchOptions`; branch on `init.method`: GET -> SSE `Response` (status 200, `content-type: text/event-stream`, real `ReadableStream` emitting `sseEvents` as `event: message\ndata: {...}\n\n`, then close; if `sseError` throw in pull); DELETE -> 204 (or `httpErrors['DELETE']`), recorded in `requests`.
7. tester — `mcp-client.test.ts`: extend `makeConnection` with optional `onNotification`/`onStreamError`; add describe block with 6 cases: (1) GET opened with `accept: text/event-stream` + session id; (2) `onNotification` fires for `notifications/tools/list_changed`; (3) multiple SSE events dispatched individually; (4) stream error -> log-and-stop (`onStreamError` called, `streaming===false`, `lastStreamError` set, status stays `'connected'`); (5) `disconnect` issues `DELETE` with session id, `status==='disconnected'`; (6) best-effort DELETE failure (500) -> no throw, status `'disconnected'`, warn invoked.
8. reviewer — review diff: header ordering (session id before user headers), DELETE non-blocking, status never flipped on stream error, abort signalled before DELETE, no uncaught GET reader rejections.
9. coder+tester — validation gate (see criteria).

## Dependencies
Step 1 (drone-core) -> Steps 2-4. Step 5 depends on 2-4. Step 6 parallel. Step 7 depends on 2,4,6. Step 8 depends on 2-7. Step 9 depends on all.

## Validation criteria
- LSP diagnostics clean (`lsp__get_diagnostics`).
- `pnpm typecheck` passes (drone-core recompiled in Step 1).
- `pnpm lint` passes (ESLint + Prettier).
- `pnpm build` succeeds.
- `pnpm test` passes; 6 new `mcp-client.test.ts` cases green.
- Optional manual: real server shows `streaming:true` after connect, `streaming:false`+`lastStreamError` after drop; `disconnect` sends DELETE.
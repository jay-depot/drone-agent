---
tags: [decision, mcp, http-transport, notifications]
related: [modules/drone-agent-mcp-client.md, decisions/050-mcp-client-session-id-iserror.md, decisions/051-mcp-client-test-suite.md]
---

# Decision 054: MCP Streamable-HTTP GET SSE Stream + `DELETE` Termination

**Status**: Implemented

**Date**: 2026-07-08

## Context

The streamable-HTTP MCP transport (`createStreamableHttpJsonRpcClient` in `client.ts`) was **POST-only**:

1. There was **no server→client channel** — the agent could never receive JSON-RPC notifications (`notifications/tools/list_changed`, `notifications/message` for logging, `notifications/progress`). Tools mounted at `onPluginsLoaded` went stale, and the server had no path to the client.
2. `disconnect` was a synchronous no-op that just flipped a `closed` flag — it never sent the `DELETE` the spec requires to terminate a streamable-HTTP session server-side. Sessions leaked and spec-compliant servers could reject reconnection.

These were item 8 in `mcp-client-gaps`. The earlier items 1 & 2 (session-id capture/echo + `isError` throwing) established the baseline; this builds the bidirectional HTTP channel on top of it.

## Decision

### 1. GET SSE reader (`openGetStream`)

After `initialize` succeeds (HTTP transport only), the client opens a **server→client** channel:

- `GET` to the same URL with `accept: text/event-stream` and the captured `mcp-session-id` header.
- Reads `response.body` via `getReader()`; accumulates bytes, splits on `\n\n`, and for each `data:` line JSON-parses the payload.
- JSON-RPC **notifications** (frames carrying a `method` and **no** `id`) are dispatched to an `onNotification(method, params)` callback. Id-bearing frames on this channel are ignored.
- The reader is **fire-and-forget** (`void openGetStream()`); `state.streaming` is set `true` when opened.

### 2. `disconnect` now sends `DELETE`

`disconnect()` (still `(options) => void`) now:

1. Sets `closed = true`.
2. `streamAbort.abort()` — stops the GET reader first (the reader's `AbortError` is swallowed silently).
3. Fire-and-forget `DELETE` to the same URL with the `mcp-session-id` header. A `.then` checks `response.ok`; a `.catch` covers rejections. **Both** route to `onStreamError`. The call is non-blocking (keeps the sync signature) and **never throws** — a `DELETE` failure is logged, not fatal, and `status` still becomes `'disconnected'`.

### 3. Hook wiring + state

- `createMcpClientConnection` accepts `onNotification`/`onStreamError` and forwards them to the HTTP builder.
- `index.ts` `onPluginsLoaded` wires them: `onNotification` logs the method; `onStreamError` logs and records `streaming=false`/`lastStreamError` on `state`. `onNotification` is the **hook point for item 6** (`tools/list_changed` re-mount) — deliberately left unwired for now.
- `DroneMcpServerState` (`drone-core`) gained `streaming?: boolean` and `lastStreamError?: string`.
- `JsonRpcClient` gained an optional `startNotifications?: () => void` (implemented only by the HTTP builder).

## Scope boundaries (deliberately deferred)

- **Auto-reconnect** of the SSE stream on a transient drop → new gap item 15.
- **Respawn crashed stdio servers** → new gap item 16.
- **Acting on `notifications/tools/list_changed`** (re-list + re-mount tools) → gap item 6; the `onNotification` hook is plumbed here but the behavior lives in item 6.
- **Advertising `logging`/`roots` capabilities + `notifications/initialized` over HTTP** → gap item 7.

## Consequences

### Positive

- The HTTP transport is now **bidirectional**: notifications flow server→client, and session termination is spec-compliant.
- A stream drop is **non-fatal** (log-and-stop); `status` is never flipped to `error` by a stream error, so a flaky SSE channel doesn't take the whole server offline.
- The `onNotification` hook is in place, so item 6 can add `tools/list_changed` re-mounting without restructuring the transport.

### Negative / tradeoffs

- No auto-reconnect yet — a sustained SSE drop leaves the channel closed until the next connect (item 15).
- Notifications are observed (logged) but not yet acted on (item 6).
- The `disconnect` `DELETE` is best-effort and unobservable to `onShutdown`'s `await` (it can't await a sync `disconnect`); a server that requires confirmation may not see teardown complete. This is acceptable for per-session HTTP servers.

## Implementation notes (gotchas discovered)

- The in-process `fetch` mock must record the **HTTP verb** (`init.method`) for GET/DELETE — those requests have no JSON body, so the JSON-RPC `method` is absent.
- The client `DELETE` must check `response.ok` (not just `.catch`): a mocked failure returns a non-ok *resolved* `Response`, not a rejection.
- The fire-and-forget GET reader can report an error **before** the caller assigns its connection handle. `index.ts` declares `let connection` ahead of the loop with an `if (connection)` guard; unit tests mirror this with a holder. Any future `onStreamError` handler reacting during connect must tolerate a not-yet-assigned handle.

## Implementation

- **Commits**: `6351021` (\"chore: commit working tree; add MCP point-8 plan + memory updates\"), `c2ad040` (\"feat(mcp): open GET SSE stream + best-effort DELETE on disconnect (point 8)\")
- **Files**: `drone-agent/src/plugins/mcp/client.ts`, `drone-agent/src/plugins/mcp/index.ts`, `drone-core/src/mcp-types.ts`, `drone-agent/test/mcp-fake-server.ts`, `drone-agent/test/mcp-client.test.ts`
- **Validation**: `pnpm typecheck` (all packages), `pnpm lint` (clean), `pnpm test` (1270 passed, 6 new MCP point-8 tests), LSP clean (hints only, no errors/warnings).
- Project memory `mcp-fix-point-8-plan` (completed plan) was deleted after ingest.

## Related

- [[modules/drone-agent-mcp-client]] — The client module page (updated for the GET SSE + DELETE behavior).
- [[decisions/050-mcp-client-session-id-iserror]] — Earlier fix establishing the HTTP baseline (session-id capture + isError throwing).
- [[decisions/051-mcp-client-test-suite]] — The two-layer test harness this change extends.
- [[architecture/config-cascade]] — `mcp` config section (server definitions).

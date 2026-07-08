---
key: mcp-client-gaps
tags:
  - mcp
  - gaps
  - testing
  - planning
created: 2026-07-07T17:29:50.826Z
updated: 2026-07-08T05:26:45.403Z
---

# MCP Client Gap Analysis (2026-07-07, updated 2026-07-08)

Source files: `drone-agent/src/plugins/mcp/index.ts`, `client.ts`; `drone-core/src/mcp-types.ts`, `config-types.ts`.
Tests EXIST: `drone-agent/test/mcp-client.test.ts` (fast, in-process `fetch` mock via `mcp-fake-server.ts`) and `mcp.test.ts` + `mcp-fake-server.mjs` (slow stdio integration). The fast suite now asserts CORRECT (fixed) behavior — the `isError` no-op is gone (see item 2) and `Mcp-Session-Id` is captured/echoed (see item 1). The `PHASE 1 RULE` comment in `mcp.test.ts:13` and the header in `mcp-client.test.ts:14-15` describe the *former* baseline that was fixed.

## Fix plan status

- **Items 1 & 2** — DONE. Implemented and verified by now-green tests (commits `418b400` deleted the completed plan after ingestion into wiki). Bug 1 = runtime-only `Mcp-Session-Id` capture/echo in `createStreamableHttpJsonRpcClient` (`client.ts` — `let sessionId` now persists and is sent as `mcp-session-id` header; test at `mcp-client.test.ts:266-282`). Bug 2 = `callTool` (`client.ts`) now throws on `isError: true`, surfaced by `executeToolSafely` as a real `{kind:'error'}` tool result (test at `mcp-client.test.ts:250-264`).

## Critical (correctness / spec compliance)

1. ~~**Streamable HTTP ignores `Mcp-Session-Id` header.**~~ **FIXED** (runtime-only capture + echo; no drone-core config change). `client.ts` reads `response.headers.get('mcp-session-id')` and echoes it on subsequent POSTs.
2. ~~**No `tools/call` `isError` handling.**~~ **FIXED.** `callTool` throws on `isError: true` (Bug 2 Option A).
3. **Tests exist.** `mcp-client.test.ts` + `mcp-fake-server.ts` cover the HTTP transport with a mocked `fetch`; `mcp.test.ts` covers stdio framing. The fast suite now encodes corrected behavior (items 1/2 flipped). DONE.

## Important (capability / robustness)

4. Hardcoded `protocolVersion: '2024-11-05'` in `initialize`, no negotiation, no newer revisions. (`client.ts` initialize params.)
5. No resource templates (`resources/templates/list`/`read`); `DroneMcpResourceMeta` only models concrete resources.
6. No `notifications/tools/list_changed` handling — tools mounted statically at `onPluginsLoaded`, go stale. (`index.ts` `onPluginsLoaded` hook.) *Hook for this (onNotification dispatch) is being plumbed by the point-8 plan; the actual re-mount logic remains here.*
7. No notification/progress/log handling; `initialize` advertises only tools/resources/prompts (no `logging`, `roots`). (`client.ts` initialize `capabilities`.)
8. **HTTP transport is single-POST only; no GET SSE stream for server→client msgs; no `DELETE` session termination (`disconnect` just flips `closed`).** **PLANNED** — implementation plan at `mcp-fix-point-8-plan`. Covers both the GET SSE stream (notification-dispatch hook) and `DELETE` termination. `DroneMcpServerState` gains `streaming?`/`lastStreamError?` fields as part of it.
9. `discoveredToolCount` set to truncated paginated count, not true server total. (`client.ts` `listTools` returns capped `items`; `index.ts` assigns `tools.length`.)

## Minor

10. No `roots` capability.
11. No `completion/complete`.
12. No spawn-timeout separate from request-timeout.
13. Tool-name sanitization collisions silently skipped (e.g. `foo bar` vs `foo-bar` both → `foo_bar`, duplicate skipped with warning in `mountMcpTools`/`registerMountedTool`).
14. No streaming / partial-content for large tool results or resources.

## New (deferred from point 8 discussion)

15. Auto-reconnect the GET SSE stream on transient drop/close (with backoff). Deferred from the point-8 fix (decision a: log-and-stop for now).
16. Respawn crashed stdio MCP servers (currently a crashed stdio server goes to `status: 'error'` permanently; no restart). Deferred from point-8 discussion.

## Remaining work (open items)
- Critical/Important: 4, 5, 6, 7, 9
- Minor: 10, 11, 12, 13, 14
- New: 15, 16
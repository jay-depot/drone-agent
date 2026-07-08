---
key: mcp-client-gaps
tags:
  - mcp
  - gaps
  - testing
  - planning
created: 2026-07-07T17:29:50.826Z
updated: 2026-07-08T01:54:22.668Z
---

# MCP Client Gap Analysis (2026-07-07, updated 2026-07-07)

Source files: `drone-agent/src/plugins/mcp/index.ts`, `client.ts`; `drone-core/src/mcp-types.ts`, `config-types.ts`.
Tests now EXIST: `drone-agent/test/mcp-client.test.ts` (fast, in-process `fetch` mock via `mcp-fake-server.ts`) and `mcp.test.ts` + `mcp-fake-server.mjs` (slow stdio integration). The fast suite deliberately encodes CURRENT (partly-defective) behavior under a "PHASE 1 RULE" so it passes today and acts as the regression net for fix-phases. The `isError` no-op is locked by `mcp-client.test.ts:233` ("does NOT surface isError to the caller (current behavior)").

## Fix plan status

- **Items 1 & 2** have a detailed implementation plan (persisted to project memory). Bug 1 = runtime-only `Mcp-Session-Id` capture/echo in `createStreamableHttpJsonRpcClient` (`client.ts:489-552`). Bug 2 = `callTool` (`client.ts:877-884`) throws on `isError: true`, surfaced by `executeToolSafely` as a real `{kind:'error'}` tool result.

## Critical (correctness / spec compliance)

1. **Streamable HTTP ignores `Mcp-Session-Id` header.** `createStreamableHttpJsonRpcClient` never reads `response.headers`, so the session id returned on `initialize` is never echoed. Real spec-compliant HTTP servers reject subsequent calls. `client.ts`. **→ Fix planned: runtime-only capture + echo (no drone-core config change).**
2. **No `tools/call` `isError` handling.** `callTool` returns raw `tools/call` result; never inspects `isError: boolean`, so tool failures look like successes. `client.ts`. **→ Fix planned: throw on `isError: true` (Bug 2 Option A).**
3. **Tests exist (stale prior note removed).** `mcp-client.test.ts` + `mcp-fake-server.ts` cover the HTTP transport with a mocked `fetch`. They currently assert CURRENT behavior (including the two defects above) and must be flipped as part of the item 1/2 fix. The slow `mcp.test.ts` covers stdio framing.

## Important (capability / robustness)

4. Hardcoded `protocolVersion: '2024-11-05'` in `initialize`, no negotiation, no newer revisions.
5. No resource templates (`resources/templates/list`/`read`); `DroneMcpResourceMeta` only models concrete resources.
6. No `notifications/tools/list_changed` handling — tools mounted statically at `onPluginsLoaded`, go stale.
7. No notification/progress/log handling; `initialize` advertises only tools/resources/prompts (no `logging`, `roots`).
8. HTTP transport is single-POST only; no GET SSE stream for server→client msgs; no `DELETE` session termination (`disconnect` just flips `closed`).
9. `discoveredToolCount` set to truncated paginated count, not true server total.

## Minor

10. No `roots` capability.
11. No `completion/complete`.
12. No spawn-timeout separate from request-timeout.
13. Tool-name sanitization collisions silently skipped (e.g. `foo bar` vs `foo-bar`).
14. No streaming / partial-content for large tool results or resources.

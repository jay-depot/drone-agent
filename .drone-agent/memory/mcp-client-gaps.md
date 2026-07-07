---
key: mcp-client-gaps
tags:
  - mcp
  - gaps
  - testing
  - planning
created: 2026-07-07T17:29:50.826Z
updated: 2026-07-07T17:29:50.826Z
---

# MCP Client Gap Analysis (2026-07-07)

Source files: `drone-agent/src/plugins/mcp/index.ts`, `client.ts`; `drone-core/src/mcp-types.ts`, `config-types.ts`.
No MCP tests exist (no `mcp.test.ts`).

## Critical (correctness / spec compliance)

1. **Streamable HTTP ignores `Mcp-Session-Id` header.** `createStreamableHttpJsonRpcClient` never reads `response.headers`, so the session id returned on `initialize` is never echoed. Real spec-compliant HTTP servers reject subsequent calls. `client.ts`.
2. **No `tools/call` `isError` handling.** `callTool` returns raw `tools/call` result; never inspects `isError: boolean`, so tool failures look like successes. `client.ts`.
3. **No tests.** 984 lines of hand-rolled protocol code (framing, retry, pagination, error classification, schema conversion) is fully unverified.

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

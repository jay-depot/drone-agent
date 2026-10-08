---
tags: [decision, mcp, bug-fix]
related:
  [
    modules/drone-agent-mcp-client.md,
    flows/tool-call-loop.md,
    drone-agent-plugins.md,
  ]
---

# 050 — MCP client: capture/echo Mcp-Session-Id + throw on tools/call isError

**Summary**: Fixed two streamable-HTTP MCP client spec-compliance defects — the client now captures and echoes the server-issued `Mcp-Session-Id`, and `callTool` throws a real error when a `tools/call` result carries `isError: true`.

## Context

`drone-agent/src/plugins/mcp/client.ts` had two known defects (tracked in project memory `mcp-client-gaps`):

1. **Session-Id not read/echoed** — The streamable-HTTP transport (`createStreamableHttpJsonRpcClient`) never read `response.headers`, so the `Mcp-Session-Id` a spec-compliant server issues on `initialize` was never captured. Spec servers then reject subsequent `tools/call` requests that lack the id → tool calls fail against real HTTP MCP servers.
2. **isError ignored** — `callTool` returned the raw `tools/call` result and never inspected `isError`. A tool failure therefore looked identical to success; the LLM would reason about a "result" that was actually an error payload.

## Decision

### Item 1 — Session-Id capture/echo (HTTP-only, runtime-only)

- Added a closure `let sessionId: string | undefined;` in `createStreamableHttpJsonRpcClient`.
- Merged into outgoing `fetch` headers **before** `...options.headers` (server-issued id authoritative; user cannot override).
- After the `if (!response.ok) throw` guard, re-read `mcp-session-id` from response headers idempotently (only when present), so the id from `initialize` is captured and echoed on later calls.
- **No `drone-core` change**: the id is captured at runtime, not pre-seeded from config (user chose runtime-only over an optional config field).

### Item 2 — Throw on isError

- `callTool` now checks `isRecord(result) && result.isError === true` and throws `MCP tool '<name>' failed[: <content text>]`.
- Added a module-local `extractToolErrorText(result)` helper that pulls text out of the result's `content` array (guarded by `isRecord` / `Array.isArray`), producing a readable message.
- No change to the mount wrapper: the conversation service's `executeToolSafely` already maps a thrown error into a real `{ kind: 'error', content }` tool result, so the LLM sees a genuine failure.

### Test scaffolding

- `mcp-fake-server.ts` gained a `sessionId?: string` option that emits the `mcp-session-id` header on the `initialize` reply only (subsequent responses stay header-less, faithful to the wire).
- `mcp-client.test.ts` replaced the old "does NOT surface isError" test (which encoded the buggy behavior) with `rejects when tools/call returns isError: true` and `still returns the raw result when isError is false`, and added a `Mcp-Session-Id` describe (`captures Mcp-Session-Id ...` plus a negative control).

## Why this is safe

- The stdio path is entirely untouched — these changes are scoped to the HTTP transport + `callTool`.
- Session-id capture is gated on `response.ok`, so error responses never clobber a captured id.
- `isError` handling is guarded by `isRecord` and uses `=== true`, so absent/unexpected shapes fall through to normal return.

## Consequences

- HTTP MCP servers that issue a session id now work (tools/call carries the echoed id).
- Tool failures surface as real errors to the LLM instead of silent successes.
- Validation: `pnpm typecheck`, `pnpm lint`, `mcp-client.test.ts` (26 passing), and the slow `mcp.test.ts` (6 passing, no regression) all green; LSP clean on `client.ts`.

## Source

- Commits `18884d2` (`fix(mcp): capture & echo Mcp-Session-Id; throw on tools/call isError`) and `bc47bc1` (memory completion summary).
- Plan: `mcp-fix-items-1-2-plan` (project memory, deleted after ingest).

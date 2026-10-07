---
tags: [decision, testing, mcp, infrastructure]
related: [modules/drone-agent-mcp-client.md, decisions/050-mcp-client-session-id-iserror.md, concepts/test-infrastructure.md, modules/drone-agent-plugins.md]
---

# ADR 051: MCP Client Test Suite (Phase 1)

**Status**: Implemented (Phase 1)

**Date**: 2026-07-07

**Commit**: `56cfd03` (`test(mcp): add fast + slow test suites for MCP client/plugin (phase 1)`)

## Context

The MCP client (`drone-agent/src/plugins/mcp/client.ts`, ~984 lines of protocol code) and its mounting logic (`index.ts`) had **no test coverage** (gap #3 in `mcp-client-gaps`). A two-layer test suite was needed so the protocol code is no longer unverified and later fix-phases have a regression net.

**Phase 1 scope was tests only** — it deliberately did *not* fix functional defects (HTTP session-id, isError, protocol negotiation, resource templates). Tests encode *current* behavior faithfully so they pass against today's code; fix-phases update the tests as the code changes, not the other way around.

## Decision

Add a fast unit suite + a slow integration suite following the monorepo vitest conventions:

- **Fast suite** (`vitest.config.ts`): `drone-agent/test/mcp-client.test.ts` — no subprocess/network.
- **Slow suite** (`vitest.integration.config.ts`): `drone-agent/test/mcp.test.ts` — spawns a real stdio child.

### Test Architecture

**Fast — in-process fetch mock (`mcp-fake-server.ts`)**
- `createMockFetch(options)` returns a `MockFetch` whose `fetch` is an in-process fake of the global `fetch` used by the streamable-HTTP transport. Parses outgoing request bodies, dispatches to per-method handlers, wraps results as JSON-RPC responses (`Response`-shaped). Records `requests` with `headers` lowercased so tests can assert on echoed headers.
- `okResponse(body)` returns a real `Headers` instance (so `.set` works for the session-id header).
- `startFakeMcpServer(opts)` returns a **descriptor** `{ scriptPath, serverConfig }` — it does *not* spawn a process. The MCP client spawns its own child from `serverConfig` (with `env` carrying tool/crash/omit-shutdown options) when the engine boots; the suite observes that client-owned child via a `vi.mock('node:child_process')` spawn spy.

**Slow — real stdio child (`mcp-fake-server.mjs`)**
- A real Node child speaking Content-Length framing, honoring `FAKE_MCP_TOOLS` / `FAKE_MCP_TOOLS_FULL` / `FAKE_MCP_CRASH_ON_INIT` / `FAKE_MCP_OMIT_SHUTDOWN` env.

**Integration through the real engine (`mcp.test.ts`)**
- Mounts `mcp__demo__*` tools + resource/prompt tools; `mcp__server_status` reports `connected`.
- Asserts child-process lifecycle (graceful `shutdown`+exit, force-kill if lingering, status → `disconnected`), `allowedTools` allowlist → `filteredToolCount`, name sanitization (`weird name!` → `mcp__demo__weird_name_`), and the unavailable-command path (`error` state, no throw).
- Observes the client-owned child via a `vi.mock('node:child_process')` spawn spy into `spawnedChildren`.

### What the fast suite covers

`createMcpClientConnection` is the natural unit under test (fully decoupled from plugin wiring; `McpClientConnection` / `McpToolMeta` are exported):

- Framing: `Content-Length` parser (one/multiple/split/invalid/missing); line-delimited parser (one-per-line, split lines, blank lines skipped, invalid JSON → closed).
- `initialize` sent once with `protocolVersion: '2024-11-05'` + capabilities; `notifications/initialized` after.
- `listTools` → `tools/list`, normalizes `McpToolMeta`, honors `nextCursor`/`cursor`, `maxListPages`/`maxListItems` caps, `toolsListTruncated`/`discoveredToolCount` (current code sets `discoveredToolCount` to the truncated count — flagged for later fix).
- `callTool` → `tools/call` with `{name, arguments}`, returns the raw result (does NOT inspect `isError` — that's fixed in [[050-mcp-client-session-id-iserror]]).
- `readResource`/`listResources`/`listPrompts`/`getPrompt` normalize metas.
- Retry: `requestWithRetry` retries idempotent methods up to `retryCount+1`, increments `retryAttemptCount`, does NOT retry non-idempotent.
- Error classification: `classifyErrorCategory` buckets timeout/transport/protocol/payload/unknown.

### Key Design Decisions / Lessons Learned

1. **The client spawns its own child.** The plan's original sketch had `startFakeMcpServer` spawn its own child and the test assert on it — wrong. The client spawns from `serverConfig` inside `createMcpClientConnection`, so a test-spawned child is never used. Fix: the descriptor returns `serverConfig`, and the test observes the client's child via a spawn spy.
2. **Tool names are `mcp__demo__*`, not `demo__*`.** The engine canonical-prefixes with the plugin id `mcp`. Tests assert the *current* naming.
3. **`vi.mock` at the top of an ESM test file is the reliable way to spy on `node:child_process.spawn`.** Patching `require('node:child_process').spawn` does NOT affect the client's ESM `import { spawn }` binding under vitest/esbuild. Avoid TDZ by referencing `actual.spawn` inside the async factory.
4. **`createMockFetch` is in-process**, so the HTTP transport is exercised with zero network — fast and deterministic.
5. **No production code modified** in `client.ts`/`index.ts` (only test files + integration config include).

## Consequences

**Positive**:
- `mcp-client.test.ts` green; `mcp.test.ts` 6/6 green under the integration config; full fast run ~1246 tests pass.
- Coverage of `client.ts`/`index.ts` MCP paths materially improved — every exported function, both framing modes, retry, pagination, and error classification covered.
- The suite is the regression net the later fix-phases (session-id, isError, protocol negotiation, resource templates) update as the code is fixed.

**Negative / deferred**:
- Phase 1 encodes current (sometimes defective) behavior; those tests must be flipped as fixes land (e.g. the isError test was flipped in [[050-mcp-client-session-id-iserror]]).
- `discoveredToolCount` truncation semantics are known-stale and await a later fix-phase.

## Related

- [[modules/drone-agent-mcp-client]] — The client under test; Testing Harness section
- [[050-mcp-client-session-id-iserror]] — The fix phase that updated these tests (isError + session-id)
- [[concepts/test-infrastructure]] — Monorepo test patterns
- [[modules/drone-agent-plugins]] — The `mcp` plugin that mounts servers

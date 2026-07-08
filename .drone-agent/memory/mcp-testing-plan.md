---
key: mcp-testing-plan
tags:
  - mcp
  - testing
  - plan
  - phase-1
created: 2026-07-07T17:34:57.974Z
updated: 2026-07-07T18:28:58.057Z
---

# MCP Client — Phase 1 Plan: Close the Testing Gap

Goal: Add a comprehensive, passing test suite for the MCP client (`drone-agent/src/plugins/mcp/`)
so the 984 lines of protocol code in `client.ts` (and the mounting logic in `index.ts`) are no
longer unverified (gap #3 in `mcp-client-gaps`). This phase ONLY adds tests — it does NOT fix
the functional defects (HTTP session-id, isError, protocol negotiation, resource templates, etc.).

CRITICAL RULE: Tests must encode CURRENT behavior faithfully so they pass against today's code.
They are the regression net the later fix-phases will update. The coder must NOT modify
`client.ts`/`index.ts` to make tests green in this phase (except trivial export additions needed
to make code testable, which must be approved).

## Context / conventions discovered

- Unit tests live in `vitest.config.ts` suite (`drone-agent/test/**/*.test.ts`), no external services.
- Slow/integration tests live in `vitest.integration.config.ts` (include list). Tests there may
  spawn real subprocesses and use longer timeouts (hookTimeout/testTimeout 60000).
- Existing pattern: `test/lsp-fake-server.ts` spawns a tiny in-process subprocess speaking framed
  JSON-RPC. NOTE: its referenced `lsp-fake-server.mjs` is currently MISSING from disk — but the
  harness shape (startFakeXServer/onRequest/offRequest/lastRequestBody/stop) is the template.
- `createMcpClientConnection(options)` in `client.ts` is the natural unit under test: it is fully
  decoupled from plugin wiring. Internal types `McpClientConnection`, `McpToolMeta` are exported.
- `index.ts` exposes `mcpPlugin` (a `DronePlugin`); mounting runs in `hooks.onPluginsLoaded`.
- Test harness helpers in `test/helpers.ts`: `createTestPlugin`, `silentLogger`, `createFakeEngine`.
- Plugin tests typically use `createDronePluginEngine({ plugins, config })` + `engine.initialize()`
  - `engine.executeTool(...)`. See `skills-plugin.test.ts`.

## Files to create / modify

- NEW `drone-agent/test/mcp-fake-server.ts` — pure in-process fake MCP server:
  - `createMockFetch` — in-process fake of global `fetch` for the HTTP transport; asserts
    outgoing request bodies / Mcp-Session-Id handling.
  - `startFakeMcpServer(opts)` — returns a descriptor `{ scriptPath, serverConfig }` for the real
    stdio child (mcp-fake-server.mjs). It does NOT spawn a process itself; the MCP client spawns
    the child from `serverConfig` (with `env` carrying tool/crash/omit-shutdown options) when the
    engine boots. The suite captures that client-owned child via a `vi.mock('node:child_process')`
    spawn spy.
- NEW `drone-agent/test/mcp-client.test.ts` (FAST suite) — unit tests against
  `createMcpClientConnection` via stubbed `fetch`:
  - Framing: `Content-Length` parser (one/multiple/split/invalid JSON/missing Content-Length).
  - Line-delimited parser (`encoding: 'line-delimited'`): one-per-line, split lines, blank lines
    skipped, invalid JSON -> closed.
  - `initialize` sent once with `protocolVersion: '2024-11-05'` + capabilities; `notifications/initialized` after.
  - `listTools` -> `tools/list`, normalizes `McpToolMeta`, honors `nextCursor`/`cursor`,
    `maxListPages`/`maxListItems` caps, `toolsListTruncated`/`discoveredToolCount`
    (current code sets discoveredToolCount to truncated count — flagged for later fix).
  - `callTool` -> `tools/call` with {name, arguments}, returns raw result (does NOT inspect isError).
  - `readResource`/`listResources`/`listPrompts`/`getPrompt` normalize metas.
  - Retry: `requestWithRetry` retries idempotent methods up to retryCount+1, increments
    `retryAttemptCount`, does NOT retry non-idempotent.
  - Error classification: `classifyErrorCategory` buckets timeout/transport/protocol/payload/unknown.
- NEW `drone-agent/test/mcp-fake-server.mjs` — real child script speaking Content-Length framing,
  honoring FAKE_MCP_TOOLS / FAKE_MCP_TOOLS_FULL / FAKE_MCP_CRASH_ON_INIT / FAKE_MCP_OMIT_SHUTDOWN env.
- NEW `drone-agent/test/mcp.test.ts` (SLOW suite) — integration through the real engine + real child:
  - mounts `mcp__demo__*` tools + resource/prompt tools; `mcp__server_status` reports `connected`.
  - NOTE: current tool naming is `mcp__<serverId>__<toolName>` (engine canonical-prefixes with the
    plugin id `mcp`), NOT `demo__<tool>`. Tests assert the CURRENT naming.
  - executes a mounted tool; allowlist (`allowedTools`) sets `filteredToolCount`; name sanitization
    (`weird name!` -> `mcp__demo__weird_name_`); child-process lifecycle (shutdown+exit then
    force-kill if lingering; status -> `disconnected`); unavailable command -> `error` state, no throw.
  - To observe the client-owned child, the test wraps `node:child_process.spawn` via `vi.mock` and
    records into `spawnedChildren`.
- MODIFY `vitest.integration.config.ts` — add `drone-agent/test/mcp.test.ts` to `include`.

## Validation criteria (ALL MET as of 2026-07-07)

- `pnpm typecheck` passes.
- `pnpm test` (fast) passes; `mcp-client.test.ts` green (1246 tests total in fast run).
- `pnpm lint` passes on new files.
- Slow suite under `vitest.integration.config.ts` passes: `mcp.test.ts` 6/6 green, child spawns,
  tools mount, shutdown/force-kill lifecycle verified, unavailable-server path verified.
- Coverage of `client.ts`/`index.ts` MCP paths materially improved (every exported function + both
  framing modes + retry + pagination + error classification covered).
- NO production code in `client.ts`/`index.ts` modified — only test files + integration config include.

## Lesson learned during execution (record for future phases)

- The plan's original sketch had `startFakeMcpServer` spawn its OWN child, and the test assert on
  that child. This was WRONG: the MCP client spawns its OWN child from the server config inside
  `createMcpClientConnection`, so a test-spawned child is never used by the client. The fix: the
  descriptor returns `serverConfig` (which the client spawns), and the test observes the client's
  child via a `vi.mock('node:child_process')` spawn spy. Also tool names are `mcp__demo__*`, not
  `demo__*`. Both are current-behavior facts the tests now encode faithfully.
- `vi.mock` at the top of an ESM test file is the reliable way to spy on `node:child_process.spawn`;
  patching `require('node:child_process').spawn` does NOT affect the client's ESM `import { spawn }`
  binding under vitest/esbuild. Avoid TDZ by referencing `actual.spawn` inside the async factory.

## Status: COMPLETE (phase 1)

Committed in 56cfd03. Tests are the regression net; later phases (HTTP session-id, isError, protocol
negotiation, resource templates) should update these tests as the code is fixed, not the other way around.

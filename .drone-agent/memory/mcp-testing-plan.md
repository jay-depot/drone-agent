---
key: mcp-testing-plan
tags:
  - mcp
  - testing
  - plan
  - phase-1
created: 2026-07-07T17:34:57.974Z
updated: 2026-07-07T17:34:57.974Z
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
  + `engine.executeTool(...)`. See `skills-plugin.test.ts`.

## Files to create / modify
- NEW `drone-agent/test/mcp-fake-server.ts` — pure in-process fake MCP server:
    - `startFakeMcpServer(opts)` returning a fake implementing the JSON-RPC surface the client uses:
      `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`,
      `prompts/list`, `prompts/get`, optional `shutdown`.
    - For STDIO tests: returns a `RpcTransport` stub object (`write`/`close`/`onData`/`onClose`/
      `onError`) the test feeds into `createStdioJsonRpcClient`-equivalent path by constructing the
      connection with a `transport: 'stdio'` config but with the transport injected. (Because
      `createMcpClientConnection` calls `spawn` internally for stdio, unit tests instead target the
      lower-level client by providing a fake transport — see "open question" note; if spawn cannot
      be injected, the stdio unit tests use a real child fed by the fake-server `.mjs` in THIS file
      and run in the SLOW suite, while HTTP unit tests use a `fetch` stub.)
    - For HTTP tests: expose a `fakeFetch` the test assigns to `globalThis.fetch`, asserting the
      outgoing `Mcp-Session-Id` handling and request bodies.
    - Support per-method handler override, cursor-based pagination simulation, error injection
      (throw / return JSON-RPC error), and recording the last request per method for assertions.
- NEW `drone-agent/test/mcp-client.test.ts` (FAST suite) — unit tests against
  `createMcpClientConnection` via stubbed transport / stubbed `fetch`:
    - Framing: `Content-Length` parser handles one message, multiple concatenated messages in one
      chunk, split-across-chunks, invalid JSON -> closed, missing Content-Length -> closed.
    - Line-delimited (`encoding: 'line-delimited'`) parser: one-per-line, split lines, blank lines
      skipped, invalid JSON -> closed.
    - `initialize` is sent once with the hardcoded `protocolVersion: '2024-11-05'` and
      capabilities {tools,resources,prompts}; `notifications/initialized` is notified after.
    - `listTools` -> calls `tools/list`, normalizes `McpToolMeta` (name/description/inputSchema),
      honors `nextCursor`/`cursor`, respects `maxListPages`/`maxListItems` caps, sets
      `toolsListTruncated`/`discoveredToolCount` (NOTE: current code sets discoveredToolCount to the
      truncated count — test asserts CURRENT behavior, flagged for later fix).
    - `callTool` -> sends `tools/call` with {name, arguments}, returns raw result. (Asserts CURRENT
      behavior: does NOT inspect `isError` — flagged for later `isError` fix phase.)
    - `readResource`/`listResources`/`listPrompts`/`getPrompt` normalize their metas correctly.
    - Retry: `requestWithRetry` retries idempotent methods (`list*`, `read*`, `get*`) on failure up
      to `retryCount`+1 attempts, increments `state.retryAttemptCount`, does NOT retry
      non-idempotent (`tools/call`, `initialize`). Inject failures via fake.
    - Error classification: `classifyErrorCategory` buckets timeout/transport/protocol/payload/unknown.
    - `server_status` tool (from `index.ts`): reports per-server state incl. mounted/filtered counts
      and error detail. (May require exercising `index.ts` mounting — if so, this belongs partly to
      the integration suite.)
- NEW `drone-agent/test/mcp.test.ts` OR `drone-agent/test/mcp-plugin.test.ts` (SLOW suite) —
  integration through the real engine + a real `.mjs` fake MCP server:
    - Add to `vitest.integration.config.ts` include list.
    - Spawn a real MCP server subprocess (new `test/mcp-fake-server.mjs`, mirroring
      `lsp-fake-server.ts` shape) that speaks Content-Length framing over stdio.
    - Configure `config.mcp.servers = { demo: { transport: 'stdio', command: node, args: [...mjs] } }`,
      `enabledPlugins: ['mcp']`, boot `createDronePluginEngine`, `engine.initialize()`.
    - Assert: `demo__*` tools mounted; `demo__list_resources`, `demo__read_resource`,
      `demo__list_prompts`, `demo__get_prompt` present; `server_status` shows `connected`.
    - `allowedTools` allowlist: only listed tools mounted; `filteredToolCount` correct.
    - Tool name sanitization: tool with non-`[a-zA-Z0-9_-]` chars mounts sanitized; duplicate
      sanitized names skipped with warning (capture logger).
    - CHILD PROCESS LIFECYCLE (the thing this phase specifically covers here): `engine` shutdown
      sends `shutdown` then `exit`, then force-kills if the process lingers; assert the child exits
      and `server_status` transitions to `disconnected`. Cover a server that omits `shutdown`
      (returns -32601) — graceful ignore path.
    - Server unavailable path: point at a non-existent command; assert `server_status` shows
      `error` with `lastErrorCategory`/`lastError` populated, no throw from `initialize`.
- MODIFY `vitest.integration.config.ts` — add the new slow MCP test(s) to `include`.

## Dependencies / order of execution
1. Create `test/mcp-fake-server.ts` (the fake server + transport/fetch stubs). Blocker for all tests.
2. Create `test/mcp-client.test.ts` (fast, unit). Depends on (1) for HTTP `fetch` stub; stdio unit
   tests depend on a decision about transport injection (see note — may be reclassified slow).
3. Create `test/mcp-fake-server.mjs` (real child script for the slow suite). Depends on (1) design.
4. Create `test/mcp.test.ts` (slow, integration). Depends on (3).
5. Modify `vitest.integration.config.ts` to include the slow test. Depends on (4).
6. Run `pnpm typecheck`, `pnpm test` (fast), `pnpm test:integration` equivalent (slow), `pnpm lint`.

## Validation criteria
- `pnpm typecheck` passes (no new type errors).
- `pnpm test` (fast suite) passes; new `mcp-client.test.ts` green.
- `pnpm lint` (ESLint + Prettier) passes on new files.
- Slow suite (the integration config) passes: child process spawns, tools mount, shutdown/force-kill
  lifecycle verified, unavailable-server path verified.
- Coverage of `client.ts` and `index.ts` MCP paths is materially improved (target: every exported
  function + both framing modes + retry + pagination + error classification covered by at least one
  test).
- NO production code in `client.ts`/`index.ts` is modified except (a) adding exports IF required to
  make `createMcpClientConnection` testable, approved explicitly, and (b) the integration config
  include edit. (Confirm with user before any other source change.)

## Open question (resolved during execution, not a blocker)
There is no seam in `createMcpClientConnection` to inject a `RpcTransport` for stdio (it calls
`spawn` internally). Two options: (A) rely on the real `.mjs` child for ALL stdio tests and put them
in the SLOW suite, keeping only HTTP unit tests (with `fetch` stub) in the fast suite; or (B) add a
small, approved testability seam (e.g. an optional `transportFactory`/`spawn` override in the options)
so stdio framing can be unit-tested in-process. Plan recommends (A) for minimal source churn this
phase, with (B) deferred to a later refactor — the coder should confirm with the user before adding
the seam.
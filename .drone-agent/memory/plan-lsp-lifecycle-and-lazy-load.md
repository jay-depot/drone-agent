---
key: plan-lsp-lifecycle-and-lazy-load
tags:
  - plan
  - lsp
  - lifecycle
  - lazy-load
created: 2026-09-08T04:21:44.863Z
updated: 2026-09-08T04:21:44.863Z
---

# Plan: LSP Lifecycle Management + Lazy Load

## Why

Running drone-agent in $HOME spawned ~7 ambient LSP servers (bash/yaml/json/dockerfile/taplo), one died mid-startup, and the transport's missing stdin error handler turned a normal EPIPE into an unhandled 'error' event that killed the whole agent. Underneath: no real process lifecycle management — no lazy start, no crash recovery (dead runtimes permanently block restart), no shutdown escalation, no crash forensics. This plan fixes the crash and restructures the lifecycle so that whole bug class is impossible.

## Session decisions (user-approved)

- Q0 EPIPE: attach stdin/stdout 'error' handlers in createChildTransport; write-after-death → transport issue → server state 'error', never process kill.
- Q1 Startup: root-marker specs (ts/py/rust/go/lua/svelte/php) stay eager; ambient specs (bash/yaml/json/dockerfile/toml/css/html) lazy-only; hasMatchingFiles removed from startup path.
- Q2 Lazy start: single requireRuntimeForFile chokepoint (find → miss → startServerForFile → re-find → throw existing "No connected LSP server" msg). Used by resolveAtPosition + 5 explicit sites (navigation.ts:174-178 find_references, symbols.ts:68-71 doc symbols, editing.ts:316-320 code_action, editing.ts:470-474 rename refId, editing.ts:603-607 formatting). get_diagnostics + workspace-symbols (symbols.ts:114-116 dummy-file path) do NOT auto-start.
- Q2b Preinstall: new config key lsp.preinstall (default false) — background install-only warm-up after eager start; shares in-flight dedup with lazy starts.
- Q3 Crash recovery: serverRuntimes holds only live runtimes; state records in separate map. Demand-driven restart (no supervisor). Crash guard: 3 failures/60s per spec → session-wide error state. Failed installs retryable (no permanent error runtimes planted).
- Q4 Concurrency: per-spec in-flight dedup Map<specId, Promise> in startServerForFile, shared with preinstall; failure clears entry; shuttingDown flag → completing start kills child (no orphans).
- Q5 Shutdown: kill() → race child close vs ~2s → SIGKILL. No process-group kills. Intentional shutdown not counted toward crash guard. disconnect-before-stdin-end ordering preserved.
- Q6 Config: only new key is lsp.preinstall; guard + kill constants hardcoded. Fragment wording: "available — starts on demand". lsp__server_status reflects error states via state records.
- Q7 Forensics: ~50-line stderr ring buffer per server in createChildTransport; on unexpected exit lastError = exit code/signal + stderr tail. Buffer internal (not in prompt fragment).

## Implementation steps

### Step 1 — transport hardening (fixes the crash) [coder]

Files: drone-agent/src/plugins/lsp/transport.ts

- In createChildTransport: attach childProcess.stdin.on('error', cb) and stdout 'error' handler; route into the existing onError callback so markClosed runs (rejects pending, sets state error). Also attach childProcess.stderr.on('data') feeding a ~50-line ring buffer; expose lastStderrTail() on RpcTransport.
- createJsonRpcClient sendMessage: on synchronous write throw, markClosed(error.message) instead of raw rethrow (notify path too).
- Unit tests: write-to-dead-child does not throw/unhandled-reject; error event surfaces as markClosed; stderr ring caps at 50 lines. Reuse/finish test/lsp-fake-server.ts (create the missing lsp-fake-server.mjs) as the wire-level harness.

### Step 2 — state/runtime separation [coder]

Files: server.ts (or new src/plugins/lsp/server/runtime-registry.ts)

- Split current runtime.state ownership: ServerRuntime no longer owns the state record; a separate Map<specId, DroneLspServerState> (serverStates) is the single source of truth for status/lastError/installSource/installStatus.
- getServerStates reads the state map. onTransportIssue updates state map. Crash/exit (transport close, not intentional shutdown) REMOVES the runtime from serverRuntimes and sets state to error with lastError = exit reason + stderr tail (from step 1).
- Remove the two "plant dead runtime with no-op client" paths (server.ts:655-697, 714-756): failures only write a state record.
- All existing tests referencing getServerStates shapes updated.

### Step 3 — lifecycle module: crash guard + in-flight dedup + shutdown escalation [coder]

New file: src/plugins/lsp/server/lifecycle.ts (server.ts is 1660 lines, over the 1000 ceiling; this work must not grow it)

- CrashGuard class: per-spec sliding window, constants FAILURE_LIMIT=3, WINDOW_MS=60_000; record(specId) and isBlocked(specId).
- createInFlightDedup(): Map<K, Promise> helper — start(key, fn) returns shared promise; failure clears entry; shared with preinstall.
- Shutdown escalation helper: killWithEscalation(child, GRACE_MS=2000) — kill() → race 'close' vs timer → SIGKILL; returns promise resolved on close (bounded).
- Unit tests for all three primitives in isolation.

### Step 4 — startup policy [coder]

Files: server.ts initializeServers/detectKnownLanguageSpecs, plugin.ts

- detectKnownLanguageSpecs: drop the hasMatchingFiles ambient branch entirely (root-marker branch stays). Remove now-dead imports/exports if nothing else uses them (check hasMatchingFiles usage; collectWorkspaceFiles stays).
- initializeServers eager-starts only: configured servers (lspConfig.servers) + root-marker detected specs.
- lsp.preinstall (see step 7 for config types): after eager starts, if enabled, fire-and-forget install-only pass over remaining KNOWN_SERVER_SPECS (respect autoInstall gates) through the step-3 dedup + installer; warn-and-continue on failures. Errors here must never reject the session start.

### Step 5 — lazy start wiring [coder]

Files: server.ts, tools/navigation.ts, tools/symbols.ts, tools/editing.ts

- New manager method requireRuntimeForFile(filePath): findRuntimeForFile → miss → startServerForFile → re-find → throw existing "No connected LSP server is available for …" message.
- resolveAtPosition uses it (covers go_to/inspect/completion/call_hierarchy/rename-normal).
- Replace the 5 duplicated find+throw sites with requireRuntimeForFile: navigation.ts:174-178, symbols.ts:68-71, editing.ts:316-320, editing.ts:470-474, editing.ts:603-607.
- Do NOT touch symbols.ts:114-116 (workspace dummy-file probing) or diagnostics tool.
- startServerForFile upgraded: per-spec dedup (step 3), crash-guard check (skip start if isBlocked, throw/state reason), remove-on-unexpected-exit interplay, and it must NOT be fooled by stale entries (live-map-only from step 2 fixes serverRuntimes.has(spec.id) blocking).
- Errors distinguish install failure vs no-spec-for-extension in the tool-facing message.

### Step 6 — shutdown ordering + bookkeeping [coder]

Files: server.ts shutdown, transport.ts

- shutdown(): for each live runtime: shutdown request (timeout swallowed) → exit notify → client.disconnect() (markClosed BEFORE stdin end — preserves EPIPE-safety) → killWithEscalation(child). Intentional path does NOT record crash-guard failures and removes runtimes cleanly.
- shuttingDown flag: set at shutdown() entry; step-3 dedup + step-5 start paths check it (a completing start kills its child, registers nothing).
- TCP/external runtimes: disconnect only (unchanged ownership semantics).

### Step 7 — config + prompt surface [coder]

Files: drone-core/src/config-types.ts, drone-core/src/config-schema.ts, drone-agent/src/plugins/lsp/plugin.ts, server.ts fragment

- drone-core: add lsp.preinstall: boolean (default false) to DroneLspConfig + TypeBox schema + config defaults. Run pnpm -r build before dependent typechecks (types resolve from dist).
- plugin.ts fragment: available-servers line becomes "- ${language} (${id}): available — starts on demand".
- lsp__server_status (via getServerStates over the state map) now surfaces crash-guard error states + lastError with stderr tails — no new tool.

### Step 8 — tests [tester]

- Unit: crash guard windows/boundaries; dedup (parallel callers single spawn; failure clears; shutdown race); killWithEscalation (SIGTERM-exit, hang→SIGKILL with fake timers/real short grace); transport EPIPE + stderr ring; requireRuntimeForFile miss→start→hit and blocked-by-guard paths.
- Integration-ish: ServerManager test with the finished lsp-fake-server.mjs: server exits mid-handshake → state error, agent process alive, next tool call restarts (dedup), 3 fast crashes → guard blocks with clear lastError.
- Update lsp-ergonomics.test.ts mocks (startServerForFile now has requireRuntimeForFile semantics; resolveAtPosition may attempt start — mocks must reflect).
- lint:dead-code: remove hasMatchingFiles if now unused, orphaned test helpers only if replaced by finished harness.

### Step 9 — file-size hygiene [coder]

- server.ts must end < 1000 lines (currently 1660): extract position-resolution helpers (parsePositionInput/resolveSymbolPosition/resolveTextPosition/reference cache) into src/plugins/lsp/server/position.ts and helpers into existing server/ dir as needed. Pure moves, no behavior change; run full test suite after.

## Order & dependencies

1 → 2 → 3 → 4 → 5 → 6 → 7 (7 needs drone-core build before dependent typecheck) → 8 (test each step as landed; step 8 consolidates) → 9 (mechanical, last). Steps 1-3 are independent enough to parallelize across coders, but 4-6 depend on 2+3. Reviewer pass after each step; reviewer must check: no error-state runtimes in serverRuntimes, no unhandled 'error' paths on child streams, constants not config (except lsp.preinstall).

## Validation criteria

- LSP diagnostics clean across all packages (pnpm typecheck / LSP tools: no errors).
- pnpm -r run lint (eslint + prettier) and pnpm -r run build: zero errors.
- pnpm -r run test (fast suite) passes; new unit tests cover: transport error/EPIPE handling, stderr ring, crash guard, in-flight dedup, kill escalation, requireRuntimeForFile lazy start, shutdown flag/orphan prevention.
- Manual repro check: launch agent in a $HOME-like dir → zero servers spawned at startup; touching a .sh/.yaml file via LSP tool starts exactly one server on demand; killing the child mid-session does not kill the agent and next call restarts it; /exit leaves no lingering child (SIGKILL within ~2s of SIGTERM).
- server.ts < 1000 lines; dead code removed; no new config keys besides lsp.preinstall.

## Out of scope

Process-group kills; supervisor auto-respawn; promoting guard/kill constants to config; tcp-server lifecycle changes; lsp-fake-server harness features beyond what error-path tests need.

---
key: plan-lsp-lifecycle-and-lazy-load
tags:
  - plan
  - lsp
  - lifecycle
  - lazy-load
created: 2026-09-08T04:21:44.863Z
updated: 2026-09-08T05:30:48.313Z
---

# Plan: LSP Lifecycle Management + Lazy Load

## Why
Running drone-agent in $HOME spawned ~7 ambient LSP servers (bash/yaml/json/dockerfile/taplo), one died mid-startup, and the transport's missing stdin error handler turned a normal EPIPE into an unhandled 'error' event that killed the whole agent. Underneath: no real process lifecycle management — no lazy start, no crash recovery (dead runtimes permanently block restart), no shutdown escalation, no crash forensics. This plan fixes the crash and restructures the lifecycle so that whole bug class is impossible.

## Session decisions (user-approved)
- Q0 EPIPE: attach stdin/stdout 'error' handlers in createChildTransport; write-after-death → transport issue → server state 'error', never process kill.
- Q1 Startup: root-marker specs (ts/py/rust/go/lua/svelte/php) stay eager; ambient specs (bash/yaml/json/dockerfile/toml/css/html) lazy-only; hasMatchingFiles removed from startup path.
- Q2 Lazy start: single requireRuntimeForFile chokepoint (find → miss → startServerForFile → re-find → throw existing "No connected LSP server" msg). Used by resolveAtPosition + 5 explicit sites (navigation.ts find_references, symbols.ts doc symbols, editing.ts code_action/rename-refId/formatting). get_diagnostics + workspace-symbols (dummy-file path) do NOT auto-start.
- Q2b Preinstall: new config key lsp.preinstall (default false) — background install-only warm-up after eager start; uses its own install-only dedup instance (not the spawn-start dedup).
- Q3 Crash recovery: serverRuntimes holds only live runtimes; state records in separate map. Demand-driven restart (no supervisor). Crash guard: 3 failures/60s per spec → block. Failed installs retryable (no permanent error runtimes planted).
- Q4 Concurrency: per-spec in-flight dedup in the shared startCandidate; failure clears entry; shuttingDown flag → completing start kills child (no orphans).
- Q5 Shutdown: kill() → race child close vs 2s → SIGKILL. No process-group kills. Intentional shutdown not counted toward crash guard. disconnect-before-stdin-end ordering.
- Q6 Config: only new key is lsp.preinstall; guard + kill constants hardcoded. Fragment wording: "available — starts on demand". Server states (incl. error + lastError with stderr tails) surface via getServerStates.
- Q7 Forensics: 50-line stderr ring buffer per server in createChildTransport; on unexpected exit lastError = exit reason + stderr tail. Buffer internal (not in prompt fragment).

## Implementation steps

### Step 1 — transport hardening (fixes the crash) [coder]
Files: drone-agent/src/plugins/lsp/transport.ts
- In createChildTransport: attach childProcess.stdin/stdout 'error' handlers routed into the child's 'error' event (plus a guaranteed no-op listener so emit never throws); createJsonRpcClient's onError → markClosed rejects pending and notifies the server layer. stderr feeds a 50-line ring buffer exposed as lastStderrTail() on ChildProcessTransport.
- createJsonRpcClient sendMessage: on synchronous write throw, markClosed(error.message) instead of raw rethrow (notify path too).
- Unit tests: write-to-dead-child does not throw/unhandled-reject; error event surfaces as markClosed; stderr ring caps at 50 lines. test/lsp-fake-server.mjs + lsp-fake-server.ts harness finished (scenario-driven: respondToInitialize / exitAfterInitialize / exitOnMethod / hangOnMethod / stderrLines; READY barrier on stderr so stdout stays clean JSON-RPC).

### Step 2 — state/runtime separation [coder]
Files: server.ts (+ server/types.ts)
- ServerRuntime no longer owns a state record; Map<specId, DroneLspServerState> (serverStates) is the single source of truth. getServerStates reads the state map.
- Unexpected transport close on a spawned server (handleSpawnedTransportIssue): removes the runtime from serverRuntimes, writes an error state with lastError = exit reason + stderr tail, records a crash-guard failure. Never runs during intentional shutdown.
- Both "plant dead runtime with no-op client" paths removed: failures only write a state record (ensureServerState).

### Step 3 — lifecycle module [coder]
New file: src/plugins/lsp/server/lifecycle.ts
- CrashGuard class: per-spec sliding window, CRASH_GUARD_FAILURE_LIMIT=3, CRASH_GUARD_WINDOW_MS=60_000; record/isBlocked/reset; injectable clock for tests.
- createInFlightDedup(): per-key shared promise; entry cleared on settle (success or failure) so failures are retryable.
- killWithEscalation(child, KILL_GRACE_MS=2000): kill() → race 'close' vs timer → SIGKILL; resolves on close; already-dead child resolves immediately.
- Unit tests for all three in lsp-lifecycle.test.ts.

### Step 4 — startup policy [coder]
Files: server.ts, plugin.ts
- detectKnownLanguageSpecs: only root-marker specs detected eagerly; hasMatchingFiles + its ambient scan removed (dead code) and the opendir import dropped.
- initializeServers eager-starts only: configured servers (lspConfig.servers) + root-marker detected specs.
- lsp.preinstall: fire-and-forget install-only pass over remaining KNOWN_SERVER_SPECS (respects autoInstall/PATH gates) through installDedup + resolveServerCommand; warn-and-continue; never rejects session start.

### Step 5 — lazy start wiring [coder]
Files: server.ts, tools/navigation.ts, tools/symbols.ts, tools/editing.ts
- startCandidate(serverId, language, config, knownSpec): the shared dedup'd start path (live re-check under dedup, crash-guard check, shuttingDown check, state records on failure, crash-guard record on spawn failure, orphan-kill if shutdown raced).
- startServerForFile: configured-server-first dispatch (findConfiguredServerForExtension covers demand restarts of configured servers) then known-spec ambient lazy start.
- requireRuntimeForFile(filePath): find → demand-start (start failure swallowed to the tool-facing error) → re-find → throw "No connected LSP server is available for …".
- resolveAtPosition + resolveSymbolPosition use it; the 5 tool find+throw sites replaced. Workspace dummy-file probing and diagnostics untouched.

### Step 6 — shutdown ordering + bookkeeping [coder]
Files: server.ts
- shutdown(): sets shuttingDown, snapshot+clears runtimes, then per runtime: shutdown request (timeout swallowed) → exit notify → client.disconnect() BEFORE stdin close (EPIPE-safe) → killWithEscalation; states set to disconnected; no crash-guard records.
- In-flight start at shutdown: completing start disconnects + kills its child and registers nothing.

### Step 7 — config + prompt surface [coder]
Files: drone-core/src/config-types.ts, config-schema.ts, drone-agent/src/plugins/lsp/plugin.ts
- drone-core: lsp.preinstall: boolean (default false) in DroneLspConfig + TypeBox schema + defaults. Four test config literals updated (terminal/prompt-file/lsp-ergonomics/log-plugin).
- plugin.ts fragment: "- ${language} (${id}): available — starts on demand"; the "no LSP servers connected" warning now only fires when nothing is connected AND nothing is available to demand-start.

### Step 8 — tests [tester]
- lsp-transport.test.ts (14): stderr ring, EPIPE routing, unhandled-rejection sweeps, spawn-failure (ENOENT) survival, write-throw → markClosed, notify-path swallowing.
- lsp-lifecycle.test.ts (18): crash guard windows/boundaries/independent specs, dedup sharing/failure-clearing/has(), kill escalation (SIGTERM-exit, SIGTERM-ignorer → SIGKILL, already-dead).
- lsp-server-lifecycle.test.ts (7): configured-command-missing → error state (no dead runtime), ambient-only workspace → zero startup servers, root-marker eager start, crash mid-session → forensics + demand restart, repeated crashes → guard blocks with tool-facing error, hung shutdown request → shutdown completes, error states carry stderr tails.
- lsp-ergonomics.test.ts mocks updated with requireRuntimeForFile.

### Step 9 — file-size hygiene [coder]
server.ts 1660 → 977 lines via extractions (pure moves): server/position.ts (matchesSurroundingBlock + resolveTextPosition/resolveSymbolPosition taking a PositionContext), server/reference-cache.ts (ReferenceCache class + readLineFingerprint + readFileSnippet), server/documents.ts (syncServerDocuments/ensureDocumentLoaded/syncFileIfNeeded), server/spawn-resolution.ts (resolveServerCommand + ResolvedSpawn), server/runtime-factory.ts (initializeClient + createRuntimeFromConfig behind a RuntimeFactoryHooks object), server/manager-types.ts (ServerManager/ResolvedPosition/CreateServerManagerOptions), server/types.ts (ServerRuntime/DocumentState). server.ts keeps: state maps, dedup, crash guard, shutdown, startup policy, startCandidate/startServerForFile/requireRuntimeForFile, parsePositionInput, delegations.

## Status: COMPLETE (2026-09-08)
All 9 steps executed on branch feature/lsp-lifecycle-management (commit 856cb05). Validation: pnpm typecheck clean (all packages + tsconfig.test.json), eslint clean, prettier clean, pnpm build clean, fast suite 2816 passed / 14 skipped (199 files), 128 LSP-specific tests passing. Dead code removed (hasMatchingFiles, plant-dead-runtime blocks, unused imports). Only new config key: lsp.preinstall. server.ts 977 lines. Manual $HOME repro left to the user (zero startup servers, on-demand start, crash recovery, no orphans on /exit).

## Order & dependencies
1 → 2 → 3 → 4 → 5 → 6 → 7 (7 needs drone-core build before dependent typecheck) → 8 → 9 (mechanical, last).

## Out of scope
Process-group kills; supervisor auto-respawn; promoting guard/kill constants to config; tcp-server lifecycle changes; lsp-fake-server harness features beyond what error-path tests need.
---
tags: [decision, lsp, lifecycle, process-management, lazy-load, reliability, hooks]
related: [modules/drone-agent-plugins.md, concepts/lsp-symbolic-resolution.md, architecture/large-file-splitting.md, decisions/102-multi-language-lsp-support.md, decisions/114-lsp-eacces-scan-and-onbeforeprompt.md, modules/drone-core.md]
---

# ADR 199: LSP Process Lifecycle Management + Lazy Load

**Status**: Implemented (commit `856cb05`, 2026-09-08, branch `feature/lsp-lifecycle-management`; follow-up `61c579d`, 2026-09-08 — hook payload + file-tool warm-up + chokepoint gap fix)

## Context

Running drone-agent in `$HOME` spawned ~7 ambient LSP servers (bash/yaml/json/dockerfile/taplo), one died mid-startup, and the whole agent crashed with EPIPE. Root causes, in layers:

1. **No stream-error routing** — `createChildTransport` attached no `error` handlers on the child's stdin/stdout. A write to a dead child's stdin surfaces as an unhandled `'error'` event (EPIPE), which by Node convention terminates the process. The `onError` callback existed but only observed the child's own `'error'` event.
2. **Ambient eager startup** — `detectKnownLanguageSpecs` treated specs with empty `rootPatterns` as "ambient": if ANY matching file existed anywhere in the tree (`hasMatchingFiles`, an unbounded recursive scan), the server was spawned eagerly. In `$HOME` that means ~7 servers rooted at `$HOME`. One (taplo) died mid-startup.
3. **Dead-runtime restart blocker** — failed startups planted a dead `ServerRuntime` with a no-op client into `serverRuntimes` with `state.status: 'error'`; `startServerForFile`'s `serverRuntimes.has(spec.id)` guard then blocked any restart forever. Decision 102's on-demand startup (`startServerForFile`) had zero callers — the lazy-load plan was never wired.
4. **No shutdown escalation** — shutdown sent LSP `shutdown`/`exit` then `kill()` with no wait or escalation, so a hung server could linger.
5. **No crash forensics** — a dead server left no stderr trail to diagnose why.

## Decision

### 1. Transport hardening (the crash fix)

`createChildTransport` now routes stream failures into the transport issue path:

- `childProcess.stdin.on('error')` and `stdout.on('error')` re-emit onto the child (so the existing `onError` → `markClosed` chain runs: pending requests reject, the server layer records the issue). A guaranteed no-op `'error'` listener on the child itself means a re-emit (or a spawn failure like ENOENT) can never become an unhandled `'error'` event even if a consumer never registers `onError`.
- `createJsonRpcClient.sendMessage` catches synchronous `transport.write` throws and routes them through `markClosed(error.message)` instead of rethrowing — on both the request and notify paths.
- stderr feeds a **50-line ring buffer** (`createStderrRingBuffer`, exported for tests) exposed as `lastStderrTail()` on the new `ChildProcessTransport` type (`RpcTransport & { lastStderrTail }`). stderr is still not a transport error (servers log diagnostics there).

### 2. Startup policy: root-marker eager, ambient lazy-only

`detectKnownLanguageSpecs` only detects specs **with `rootPatterns`** (typescript, python, rust, go, lua, svelte, php) via `workspaceHasMarkers`. The ambient `hasMatchingFiles` branch and the helper itself are deleted (dead code). Ambient languages (shell, yaml, json, dockerfile, toml, css, html) start **on demand** when a matching file is touched through an LSP tool. `$HOME`-like directories now start zero servers.

The plugin's "no LSP servers connected" startup warning now only fires when nothing is connected **and** nothing is available to demand-start; the `lsp-status` fragment's available-servers line reads "available — starts on demand".

### 3. Lazy start via a single chokepoint

`requireRuntimeForFile(filePath)`: `findRuntimeForFile` → miss → `startServerForFile` (failure swallowed and logged) → re-find → throw the existing tool-facing "No connected LSP server is available for …" message. Wired into `resolveAtPosition` (covers go_to/inspect/completion/call_hierarchy/rename-normal), `resolveSymbolPosition`, and the five duplicated find+throw tool sites (find_references, symbols-document, code_action, rename-referenceId, formatting). Deliberately NOT wired: `get_diagnostics` (file-level tool) and workspace-symbols' dummy-file probing (must not spawn servers to answer a search).

**Correction (61c579d)**: the "five duplicated find+throw sites" claim above was aspirational — the `code_action` implementation had actually kept its `findRuntimeForFile` + throw, leaving it the one position tool outside the chokepoint (undetected because its error message was byte-identical and its test doubles already implemented `requireRuntimeForFile`). `code_action` now genuinely routes through `requireRuntimeForFile`; because `startDedup` joins in-flight starts, a `code_action` call racing a warm-up start waits for the connection instead of failing during the warm-up window. Error message unchanged for unservable files.

`startServerForFile` dispatches **configured-server-first** (`findConfiguredServerForExtension` over `lspConfig.servers`), then known-spec ambient — so a crashed *configured* server restarts as itself rather than silently switching to the spec default. Both paths converge on a shared `startCandidate` (below).

### 4. State/runtime separation (restartable servers)

`ServerRuntime` no longer owns its state record. A separate `Map<specId, DroneLspServerState>` (`serverStates`) is the single source of truth for status/lastError/install fields; `getServerStates()` reads it. Both "plant dead runtime with no-op client" paths are removed — failures write only a state record (`ensureServerState`). An **unexpected** transport close on a spawned server (`handleSpawnedTransportIssue`) removes the runtime from the live map, writes an error state with `lastError = exit reason + "\nstderr tail:\n" + tail`, and records a crash-guard failure. The next tool call demand-restarts cleanly.

### 5. Lifecycle primitives (`server/lifecycle.ts`)

- **`CrashGuard`** — per-spec sliding window (`CRASH_GUARD_FAILURE_LIMIT = 3`, `CRASH_GUARD_WINDOW_MS = 60_000`), injectable clock for tests; `record`/`isBlocked`/`reset`. A blocked spec refuses demand starts (logged) until failures age out.
- **`createInFlightDedup()`** — per-key shared promise; the entry clears on settle (success **or** failure) so a failed start is immediately retryable. Two instances: `startDedup` (demand starts of the same spec share one spawn) and `installDedup` (the preinstall warm-up) — install-only warm-up must not be joined by spawn-starts expecting a live server.
- **`killWithEscalation(child, KILL_GRACE_MS = 2000)`** — `kill()` → race `'close'` vs timer → SIGKILL; resolves on close (bounded); already-dead children resolve immediately.

`startCandidate` (the shared start path) checks, under the dedup: live runtime (re-check — another caller may have finished), crash guard, and `shuttingDown`. Spawn failures record a crash-guard failure and throw a `Failed to start/prepare LSP server <id>: <message>` error (distinct from the no-spec case). If teardown began mid-start, the completing start disconnects + escalates its own child and registers nothing (orphan prevention).

### 6. Shutdown ordering

`shutdown()` sets `shuttingDown`, snapshots + clears the runtimes map, then per runtime: LSP `shutdown` request (timeout swallowed) → `exit` notify → **`client.disconnect()` before stdin close** (markClosed runs first so an in-flight write completion cannot surface as EPIPE — the EPIPE-safe ordering) → `killWithEscalation` for spawned children. Intentional shutdown never records crash-guard failures. TCP/external runtimes: disconnect only (unchanged ownership).

### 7. Config: `lsp.preinstall`

One new drone-core config key: `lsp.preinstall: boolean` (default **false**, opt-in) on `DroneLspConfig` + TypeBox schema + defaults. When enabled, after eager startup a fire-and-forget install-only pass resolves every known-but-not-running, not-configured spec through `resolveServerCommand` (respecting `autoInstall`/PATH gates) — warms the cache without spawning servers. Failures warn and continue; the warm-up can never reject session start. Guard + kill constants stay hardcoded (Q6 decision).

### 8. Follow-up: `onAfterToolCall` payload + file-tool warm-up (61c579d)

Demand start was reactive only: an ambient server first spawned when an LSP *tool* asked, so passive diagnostics never warmed up from ordinary file work. The natural first contact — the agent reading or writing a file — carried no signal.

- **Payload contract**: `DroneAfterToolCallPayload` (`drone-core`) — `{ calls: [{ name, arguments }] }` listing every tool call in the round (parallel batch from one LLM response; single entry for `/tool` and `/exec`). `DronePluginHooks.onAfterToolCall` callbacks take it as an **optional** parameter (zero-arg consumers stay assignable), and `runHooks` gains an overload `('onAfterToolCall', payload)` — the engine implementation takes `(hookName, payload?)` so other hook names stay payload-less. AGENTS.md's Hook Ordering section documents this.
- **LSP consumption**: the plugin matches path-bearing file tools (`read`/`write`/`apply_diff`, canonical `file__read` + bare `read` forms via `filePathFromToolCall`), resolves the path, skips when a runtime is already connected (`findRuntimeForFile` fast path), and fires `void startServerForFile(...)` — **fire-and-forget**: startup latency never blocks the tool round, and `startDedup` collapses concurrent attempts (join semantics give racers the shared promise). Failures are logged/state-recorded by the manager.
- **Tests**: `test/lsp-plugin-warmup.test.ts` (8 tests; `vi.waitFor` polling, no fixed sleeps) — path extraction unit cases, a real-manager warm-up attempt observed via the failure warning, no-op cases (non-file tools, `lsp.enabled: false`), and the `code_action` chokepoint regression (tool-facing error unchanged + `lsp demand start failed` proves the demand path ran).
- En-route: `pnpm lint` is root-level (not `-r`); vitest must run from the repo root (workspace config), not the package dir.
## Consequences

### Positive

- The `$HOME` crash class is structurally impossible: no ambient eager spawns, no unhandled stream errors, no dead-runtime blockers.
- Crash recovery works: mid-session child death → error state with stderr forensics → next tool call transparently restarts.
- Crash loops are bounded (3/60s) instead of spinning.
- `/exit` cannot leave lingering children (SIGKILL within ~2s of SIGTERM).
- `server.ts` went from 1660 lines (over the 1000 ceiling) to 977 via pure extractions.

### Negative / tradeoffs

- Ambient languages cost one demand-start round-trip (install resolve + spawn + initialize) on first touch instead of being pre-spawned.
- The preinstall warm-up is install-only; it does not pre-warm server *state* (initialize happens on demand).
- Four test config literals needed `preinstall: false` added (new required key).

## En-route lessons

- The fake LSP server's `READY` barrier originally went to **stdout**, corrupting Content-Length framing when the transport attached to the same pipe ("message without Content-Length") — control channels must stay off a protocol stream; moved to stderr.
- Tests must kill the *manager's* spawned child (`findRuntimeForFile().childProcess`), not the harness's own instance, or demand-restart tests fail confusingly.
- The first `startServerForFile` rewrite dispatched purely by known-spec extension match, silently hijacking crashed *configured* servers to spec defaults — configured-first dispatch preserves restart identity.

## Implementation

- **Branch**: `feature/lsp-lifecycle-management`
- **Commits**: `165b1e4` (plan memory), `856cb05` (the feature), `258354b` (memory wrap-up)
- **Files**: `drone-agent/src/plugins/lsp/transport.ts` (hardened), `server/lifecycle.ts` (new), `server/{position,reference-cache,documents,spawn-resolution,runtime-factory,manager-types,types}.ts` (new extractions), `server.ts` (1660→977), `server/helpers.ts` (`hasMatchingFiles` removed), `plugin.ts` (fragment + warning), `tools/{navigation,symbols,editing}.ts` (chokepoint), `drone-core/src/config-{types,schema}.ts` (`lsp.preinstall`), `test/lsp-fake-server.{ts,mjs}` (finished harness), `test/lsp-{transport,lifecycle,server-lifecycle}.test.ts` (new suites)
- **Tests**: 128 LSP tests total (14 transport + 18 lifecycle primitives + 7 ServerManager integration + existing suites with updated mocks); validation: typecheck/lint/build clean, fast suite 2816 passed / 14 skipped
- **Follow-up files** (61c579d): `drone-core/src/plugin-system.ts` + `index.ts` (payload type + hook signature + slash-context `runHooks` overload), `drone-agent/src/runtime/{plugin-engine,conversation-service,builtin-commands}.ts` (dispatch + fire sites), `drone-agent/src/plugins/lsp/plugin.ts` (`filePathFromToolCall` + warm-up), `drone-agent/src/plugins/lsp/tools/editing.ts` (`code_action` → chokepoint), `test/lsp-plugin-warmup.test.ts` (new), AGENTS.md (hook-ordering payload paragraph); fast suite 2824 passed / 14 skipped

## Related

- lsp-symbolic-resolution — position-resolution layer (its helpers now live in `server/position.ts` / `server/reference-cache.ts`)
- [drone-agent-plugins](../../drone-agent/src/plugins/) — the lsp plugin row
- [large-file-splitting](048-large-file-splitting.md) — `lsp/server.ts` is now fully under the 1000-line ceiling
- [102-multi-language-lsp-support](102-multi-language-lsp-support.md) — original known-specs + on-demand startup (now actually wired)
- [114-lsp-eacces-scan-and-onbeforeprompt](114-lsp-eacces-scan-and-onbeforeprompt.md) — earlier scan hardening (`collectWorkspaceFiles` still used for document sync)
- [143-lsp-tool-reliability](143-lsp-tool-reliability.md) — tool reliability round that established the tool-facing error message reused by the chokepoint

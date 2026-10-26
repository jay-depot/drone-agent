# ADR 264: Shutdown Hardening — MCP/LSP exit hangs, beacon-first inform, watchdog, event-driven SIGKILL escalation

**Status**: Accepted (2026-10-26, branch `fix/shutdown-handling-and-hook-ordering`)

## Context

The agent could hang forever at exit. Four failure classes:

1. **No deadline on `onShutdown`.** `main()` awaited `engine.runHooks('onShutdown')` with no bound on duration, so one hung hook blocked process exit indefinitely.
2. **Teardown left handles holding the event loop open.** The MCP plugin's respawn monitor could orphan a spawned child (`disconnect()` saw the dead child, not the replacement); the long-lived GET SSE stream was opened with the per-request `AbortSignal.timeout`, which tore it down every ~10s and leaked a reader; LSP `killWithEscalation` resolved only on the child's `'close'` event, which a D-state (uninterruptible-sleep) child never emits; in-flight `npm install` / `go build` children were untracked; and both plugins trashed connections/runtimes sequentially, so shutdown cost was the sum of per-item timeouts.
3. **Signal handling was not universal.** Only `runSwarmListenMode` registered signal handlers; `runJsonListenMode` and `runInteractiveLoop` did not, and `runJsonMode`'s error path called `process.exit(1)` directly, skipping `onShutdown` hooks.
4. **SIGKILL escalation was dead in spawners.** `ChildProcess.killed` flips `true` the moment `kill()` is called, so the `!process.killed` guard in the gateway's `terminate` and the shared `terminateAgent` never fired the SIGKILL escalation for a SIGTERM-ignoring agent.

## Decision

### 1. `session.shutdownTimeoutMs` (drone-core)

New drone-core config key `session.shutdownTimeoutMs` (default **30000**) bounds the exit watchdog. Added to `config-types.ts` (optional, with the defaults block), `config-schema.ts` (optional positive integer), and `config-keys.ts` (known-keys allowlist).

### 2. Per-hook `onShutdown` priority

`onShutdown(callback, options?)` accepts `options?: { priority?: number }` — the options param lives on the hook registration, not on plugin metadata. Semantics:

- Lower numeric priority runs first.
- Hooks without an explicit priority run **last**, in registration order (missing = last, not middle).
- Explicit-priority hooks sort ascending; the sort is **stable**, so equal priorities keep registration order.
- Existing one-argument registrations are unchanged (purely additive signature).
- The engine sorts a copy per run, so a hook that registers another hook during shutdown does not reorder the in-flight run.

The swarm plugin's `registerShutdown` registers with `{ priority: 0 }`, so the agent informs the beacon of shutdown before every other `onShutdown` hook: set `shuttingDown`, clear heartbeat intervals, close the WebSocket, flush the event buffer, unregister the config injector, then `DELETE /sync/sessions/:id` and `DELETE /agents/:id` (best-effort). The beacon sees the agent go offline even if a later hook blocks forever.

### 3. MCP teardown

- **Track every spawned child.** A per-connection `Set<ChildProcess>` records each child at creation (before any `await`), so there is no window in which a live child exists untracked. `disconnect()` kills the whole set (SIGTERM, escalated to SIGKILL after 2500ms; each per-child promise also resolves on that timer, so `disconnect()` is bounded). This kills the respawn orphan that `disconnect()` could never see.
- **Post-initialize closed check.** After `await initialize(...)`, a child that died during its own handshake is killed rather than promoted to `childProcess`.
- **Owned AbortController for the GET SSE stream.** The long-lived server→client stream uses a per-client `AbortController` instead of `AbortSignal.timeout(requestTimeoutMs)`, fixing the 10s stream-kill churn; it is aborted at teardown. POST requests keep their per-request timeout.
- **Parallel disconnect.** `onShutdown` disconnects connections with `Promise.all`, so wall-clock cost is the slowest server, not the fleet.

### 4. LSP teardown

- **`killWithEscalation` resolves on `'exit'`, not `'close'`**, with SIGKILL at `graceMs` (2000) and a hard fallback timer at `graceMs + 1000` that resolves unconditionally — the promise can never hang, even on a D-state child.
- **Installer children tracked and killed.** `npm install` / `go build` run through a wrapper that owns the callback form of `execFile`, tracks each child in a `Set`, and `killRunningInstalls()` SIGTERM→SIGKILLs them with the same escalation+bound.
- **Parallel runtime shutdown.** LSP `shutdown()` runs per-runtime teardown (shutdown request → exit notify → `disconnect()` → `killWithEscalation`) in a `Promise.all` alongside `killRunningInstalls()`.

### 5. Universal SIGTERM / SIGINT in all run modes

- `runJsonListenMode` and `runInteractiveLoop` register once-handlers for SIGTERM/SIGINT that call the runtime capability's `cancelCurrentRequest()` and close the readline, so the loop returns normally and the caller's `onShutdown` hooks run. Handlers are removed in the `finally` block. This matches the existing `runSwarmListenMode` signal pattern.
- `runJsonMode`'s error path sets `process.exitCode = 1` instead of `process.exit(1)`, so `onShutdown` hooks run before the process exits.
- **No-self-signal constraint.** Shutdown is never triggered via `process.kill` or self-signaling — SIGTERM is uncatchable on Windows, so a self-signal would skip `onShutdown` entirely. Shutdown is routed in-process (deferred `shutdownSignalRef` / `cancelCurrentRequest` pattern).

### 6. Watchdog in `main()`

`main()` arms `armShutdownWatchdog(session.shutdownTimeoutMs ?? 30000)` (from `src/runtime/shutdown-watchdog.ts`) **before** `runHooks('onShutdown')`. The watchdog is an unref'd timer that force-exits with code 1 if the deadline elapses. On clean completion the disarm helper clears the watchdog and arms a residual 5s unref'd timer (`SHUTDOWN_RESIDUAL_MS`) that exits with `process.exitCode ?? 0`, so leftover handles are cut at 5s and the exit code of a clean shutdown is preserved. `process.exit` is the only force-exit mechanism.

### 7. Event-driven SIGKILL escalation in spawners

- **Gateway (`local-spawn-backend.ts`).** `TERMINATE_GRACE_MS = 5000`; after SIGTERM, an unref'd grace timer sends SIGKILL only if `exitCode`/`signalCode` are still `null` when it fires (a child that exited during the window is not killed). A `'exit'` listener clears the timer. The dead `!process.killed` check — which never fired because Node sets `.killed = true` on `kill()` — is replaced.
- **`drone-swarm-common` (`spawner.ts`).** The same event-driven fix in the shared `terminateAgent` (covers beacon + coordinator spawns). Already-exited children get no signals and no timer.

## Consequences

### Positive

- Shutdown is bounded: the watchdog force-exits within `shutdownTimeoutMs`, and the residual timer bounds the post-hook tail.
- The beacon is always told first: priority-0 swarm hook means the inform sequence runs before any other hook, even one that blocks forever.
- MCP and LSP teardown can no longer hang the event loop: every child is tracked and killed, every stream owned and aborted, every escalation ladder ends in a timer that resolves unconditionally.
- SIGTERM/SIGINT now produce a graceful shutdown (including `onShutdown`) in every run mode, on every platform.
- Spawner SIGKILL escalation works again — the `.killed`-flag bug is gone from both the gateway and the shared spawner.

### Negative / tradeoffs

- A hung shutdown now dies with exit code 1 after `shutdownTimeoutMs` instead of hanging — the watchdog converts "hang forever" into "force-exit at the deadline," which is the intent but is still a hard kill (cleanup may be cut off).
- Hooks without an explicit priority are demoted behind every prioritized hook; adding a priority to one hook silently reorders the rest.
- Config keys and hook signatures are extended (optional), so existing registrations and config files remain valid.

## Implementation

- **Branch**: `fix/shutdown-handling-and-hook-ordering`
- **Commits**: `7e934482` (workstream A: config key + hook priority + swarm priority 0), `85231cce` (workstream C: LSP), `e00d8fd8` (workstream B: MCP), `a42b227b` (workstream E: watchdog), `74bf26b1` (workstream F: swarm-common spawner), `b11efae8` (workstream F: gateway), `ebc450a7` (workstream F: universal SIGTERM/SIGINT)
- **Files**: `drone-core/src/config-{types,schema,keys}.ts`, `drone-core/src/plugin-system.ts`, `drone-agent/src/runtime/{plugin-engine.ts,shutdown-watchdog.ts}`, `drone-agent/src/index.tsx`, `drone-agent/src/interactive.ts`, `drone-agent/src/plugins/swarm/heartbeat.ts`, `drone-agent/src/plugins/mcp/{client.ts,index.ts}`, `drone-agent/src/plugins/lsp/{installer.ts,server.ts,server/lifecycle.ts}`, `drone-gateway/src/local-spawn-backend.ts`, `drone-swarm-common/src/spawner.ts`

## Related

- [199-lsp-lifecycle-management](199-lsp-lifecycle-management.md) — LSP process lifecycle; its Q5 shutdown decision (`kill()` → race `close` vs ~2s → SIGKILL) is superseded by this ADR's `'exit'` + hard-fallback escalation
- [040-message-queue-cancel](040-message-queue-cancel.md) — the soft-cancel (`cancelCurrentRequest`) machinery the signal handlers reuse
- [114-lsp-eacces-scan-and-onbeforeprompt](114-lsp-eacces-scan-and-onbeforeprompt.md) — earlier hook non-fatality work in the same hook system
- [231-agent-termination-ladder-and-reconcile](231-agent-termination-ladder-and-reconcile.md) — agent termination; this ADR fixes the SIGKILL escalation leg of the ladder

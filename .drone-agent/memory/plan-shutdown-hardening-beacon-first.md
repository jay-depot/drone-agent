---
key: plan-shutdown-hardening-beacon-first
tags:
  - plan
  - shutdown
  - hang
  - mcp
  - lsp
  - swarm
  - gateway
  - beacon
  - watchdog
created: 2026-10-26T18:36:38.456Z
updated: 2026-10-26T18:36:38.456Z
---

# PLAN: Shutdown Hardening — MCP/LSP exit hangs, beacon-first inform, gateway SIGKILL escalation

## Problem

Agent can hang forever at exit. MCP/LSP teardown can leave children/streams keeping the Node event loop open. engine.runHooks('onShutdown') has no deadline. Gateway SIGKILL escalation is dead code (!process.killed check — Node sets .killed=true on kill() call, so it never fires).

## Goal (3 parts)

1. Fix every known MCP/LSP exit-hang.
2. Swarm informs beacon FIRST before other onShutdown hooks (Spec 1).
3. Gateway SIGKILL escalation actually fires (Spec 2) — event-driven, 5s grace.

## Locked decisions (grilling Q1-Q13, 2026-10-26)

- Q1 JSON run modes (runJsonMode, runJsonListenMode, runInteractiveLoop) must catch SIGTERM — they don't today (only runSwarmListenMode does).
- Q2 onShutdown gets optional per-hook priority; lower first; missing = last (preserves current behavior); stable sort. Swarm registers priority 0.
- Q3 Reordering existing swarm shutdown IS Spec 1 (flushEventBuffer + DELETE /sync/sessions + DELETE /agents). No new beacon endpoint.
- Q4 On SIGTERM, ABORT in-flight turn via cancelCurrentRequest, then shutdown.
- Q5/Q9 Watchdog armed BEFORE runHooks, 30s budget, unref'd; residual after-hooks safety (5s). Bounds hung-hook AND leftover handles.
- Q6 Gateway escalation: SIGKILL unless child actually exited (exitCode/signalCode null check), keep 5s. Fix same dead check in drone-swarm-common/src/spawner.ts terminateAgent.
- Q7 MCP: BOTH fixes — Set<ChildProcess> tracks every spawned child (add right after spawn, before awaits); disconnect() kills all tracked; post-initialize closed check in respawn monitor. LSP does NOT share child-process code (verified: separate transport.ts/client.ts). LSP has NO respawn-orphan (demand-driven, startCandidate already has shuttingDown guard). LSP needs: (a) killWithEscalation hard-resolve, (b) track installer children (npm/go execFile) + kill on shutdown. Both confirmed.
- Q8 Parallel teardown: Promise.all in both MCP disconnect loop + LSP runtime shutdown loop.
- Q10 SSE churn fix rides disconnect AbortController: drop AbortSignal.timeout(requestTimeoutMs) from GET SSE stream (it kills stream every 10s → TimeoutError spam, filed wiki bug), abort via owned controller on disconnect. POST keeps per-request timeout.
- Q11 Per-hook priority (on the hook registration, options param), not plugin metadata.
- Q12 runJsonMode error path process.exit(1) → process.exitCode = 1 so onShutdown runs.
- Q13 Watchdog deadline = config key session.shutdownTimeoutMs, default 30000 (PR #146 additive shape).

## Constraint — DO NOT VIOLATE

Never self-signal (SIGTERM uncatchable on Windows → onShutdown never runs). Route in-process via shutdownSignalRef deferred pattern only.

## Steps (dependency map)

1. drone-core: add session.shutdownTimeoutMs (config-types.ts default block ~L665: 30000; config-schema.ts optional PositiveNumber; config-keys.ts allowlist) — PR #146 additive shape.
2. drone-core + engine: DronePluginHooks.onShutdown(cb, {priority?}) optional 2nd param. plugin-engine.ts: HookBuckets.onShutdown → Array<{fn, priority?}> (L67, L327, L914); runHooks (L1328) branches for onShutdown: stable sort explicit priorities ascending first, missing last, then await. swarm/heartbeat.ts registerShutdown registers { priority: 0 }. Test in test/plugin-engine.test.ts (order, default-last, stability, swarm opts in).
3. mcp/client.ts createMcpClientConnection: spawnedChildren Set<ChildProcessWithoutNullStreams>; add on initial spawn (~L1231) + in startRespawnMonitor (~L1440) right after spawn with once('exit') delete; post-initialize closed check before childProcess = newChild (disconnect+kill if closed); disconnect (~L1583) kills ALL tracked via timer (2500ms force-kill delay), NOT just childProcess. Test: orphan killed mid-initialize.
4. mcp/client.ts createStreamableHttpJsonRpcClient: streamAbort AbortController; openGetStream uses controller.signal NOT AbortSignal.timeout; abort in disconnect + loop exit. Fixes filed SSE-timeout spam bug. Test: disconnect aborts fetch signal, no timeout stream-error.
5. mcp/index.ts onShutdown (~L621): Promise.all([...connections].map(c => c.disconnect() → setServerState)). Test: elapsed ≈ max not sum.
6. lsp/server/lifecycle.ts killWithEscalation: resolve on 'exit' (not 'close') + SIGKILL at graceMs + 1s hard fallback resolve. Comment "bounded by grace" was false. Test in lsp-lifecycle.test.ts (both-signals-ignored child resolves).
7. lsp/installer.ts: runningInstalls Set + trackInstallChild + killRunningInstalls() (SIGTERM→SIGKILL after grace + hard fallback); replace execFileAsync call sites (npm ~L584, go ~L611) with tracked wrapper. server.ts shutdown calls killRunningInstalls(). Test: lsp-installer-shutdown.test.ts.
8. lsp/server.ts shutdown (~L942): extract shutdownRuntime(runtime), Promise.all([...runtimes.map(shutdownRuntime), killRunningInstalls()]). Test: timing ≈ max.
9. interactive.ts runJsonMode: process.exit(1) → process.exitCode = 1 (catch ~L202); signal handlers cancelCurrentRequest via runtime capability. Test: exitCode set, process.exit not called, onShutdown runs.
10. interactive.ts runJsonListenMode (~L241): once SIGTERM/SIGINT handlers → cancelCurrentRequest() + rl.close() to end for-await; remove in finally. Gateway's persistent mode. Test: json-listen-mode-signal.test.ts.
11. interactive.ts runInteractiveLoop: same once-handler pattern (cancel + rl.close).
12. index.tsx (~L587): watchdog = setTimeout(process.exit(1), session.shutdownTimeoutMs ?? 30000).unref() BEFORE runHooks; finally clearTimeout + residual 5s unref'd setTimeout(process.exit(exitCode ?? 0)). Factor watchdog into exported helper (src/runtime/shutdown-watchdog.ts) for testability with fake timers. SHUTDOWN_RESIDUAL_MS = 5000.
13. drone-gateway/local-spawn-backend.ts terminateSession (~L309): SIGTERM; graceTimer 5s → SIGKILL only if exitCode===null && signalCode===null; unref; child.once('exit', clearTimeout). TERMINATE_GRACE_MS = 5000. Test: local-spawn-backend.test.ts + fake timers.
14. drone-swarm-common/spawner.ts terminateAgent (~L244): same event-driven fix (beacon path funnels through this via drone-beacon/src/spawner.ts → coordinator-spawn covered). inject/spawn-once.ts (L104): optional align — skip SIGKILL if exited.
15. Docs: docs/agents/hook-ordering.md (priority contract, swarm-first guarantee, watchdog, universal SIGTERM, no-self-signal); new ADR docs/adr/NNN-shutdown-hardening.md.

## Validation criteria (final step)

1. LSP checks (typescript) zero errors/warnings in drone-core, drone-agent, drone-gateway, drone-swarm-common.
2. pnpm -r run build exit 0. 3. pnpm run lint zero errors. 4. pnpm run test fast suite green incl. new tests. 5. Behavioral spot-checks: MCP orphan killed; SSE no timeout spam; LSP kill hard fallback; swarm-first order; gateway SIGKILL at 5s; watchdog forces exit on hung hook, clean path unaffected. 6. No dead code; no process.exit(1) in JSON error path; no AbortSignal.timeout on GET stream.

## Executor note

After editing drone-core types, run pnpm -r run build BEFORE relying on LSP/typecheck in dependent packages (they resolve drone-core from dist/, not source).

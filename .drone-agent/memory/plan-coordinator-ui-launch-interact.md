---
key: plan-coordinator-ui-launch-interact
tags:
  []
created: 2026-09-07T23:45:09.036Z
updated: 2026-09-08T02:02:58.322Z
---

# Plan: Coordinator UI — Launch & Interact with Swarm Agent Sessions — ✅ COMPLETED 2026-09-08

## Execution summary (all 8 phases done, branch feat/coordinator-ui-sessions)

- **Phase 1 (CLI step-0 blocker):** `--swarm`, `--session-id`, `--beacon-host`, `--beacon-port`, plus `--task`/`--working-dir` (spawner also passes these) added to CliOptions + parseCliArgs; `swarmSpawned` runtime option/flag on `_runtime`; `--swarm` force-enables the swarm plugin; CLI overrides threaded into createSwarmPlugin via new `swarmConfig` dep. Shared spawner now passes `--output-json` (interactive listen-mode, no --once).
- **Phase 2 (synthetic-turn API):** ConversationService gained `submitUserMessage(content)` (mutex via promise-chain; queue-if-in-flight, send-immediately otherwise) + `isTurnInFlight()`; exposed on `_runtime` via mutable refs wired in index.tsx.
- **Phase 3 (swarm listen-mode):** new WS `userMessage` type in swarm websocket.ts → `_runtime.submitUserMessage` (steer:true → cancelCurrentRequest first); `runSwarmListenMode` in interactive.ts (NDJSON streaming via global event listener, resolves on SIGTERM/SIGINT); registerSwarmSession forwards `interactive` when swarmSpawned.
- **Phase 4 (interactive flag):** coordinator `swarm_sessions.interactive` column (idempotent migration), SwarmSession type + all row mappings, register route accepts `interactive`, beacon sync proxy + coordinator-client forward it.
- **Phase 5 (message endpoint):** coordinator `POST /api/sessions/:id/message {content, steer}` → reverse-channel `deliverUserMessage` command → beacon `handleDeliverUserMessage` → agent WS `userMessage`. 404/502/503 error handling.
- **Phase 6 (launch panel):** sessions page New Session button + dropdown panel (Beacon required from connected beacons, Persona optional, CWD Root required from beacon-advertised spawnRoots w/ defaultSpawnRoot default) → POST /api/spawn → navigate to session detail.
- **Phase 7 (session chat):** session-detail fetches session metadata; live+interactive (active && interactive) shows textarea + Send + Stop & Send split button → POST /api/sessions/:id/message; non-live sessions render events read-only; status badge reflects real status.
- **Phase 8 (validation):** new tests cli-swarm-flags.test.ts (9) + submit-user-message.test.ts (4, incl. mutex concurrency + queue-vs-send + failure isolation). Full fast suite 2805 passed/14 skipped; typecheck, build, lint (eslint+prettier) all green. Also fixed pre-existing LSP error in drone-coordinator/test/beacon-ws.test.ts (fake ws missing handlers prop) and added `interactive: false` to transcript.test.ts fixture.

## Implementation notes / deviations
- Plan gap: spawner also passes `--task`/`--working-dir`, which parseCliArgs would have rejected (same step-0 blocker class). Parsed both; `--task` is NOT yet wired as a first turn (deferred — plan only required boot).
- Plan gap: runJsonListenMode is stdin-driven; added `runSwarmListenMode` (WS-sourced turns, SIGTERM-resolving keepalive) instead of reusing it.
- ConversationService object literal needed a `service` self-reference for submitUserMessage to call sendUserMessage.
- eslint config lacks react-hooks plugin; removed an eslint-disable-line for react-hooks/exhaustive-deps.

## Key decisions (original plan, retained)
Model B (synthetic turns) reusing A's plumbing; hybrid queue/Stop-&-Send; interactive flag set at registration; all UI-launched sessions purely interactive; CWD roots prerequisite (decision 197) already implemented.

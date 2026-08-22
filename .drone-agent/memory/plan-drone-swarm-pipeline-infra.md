---
key: plan-drone-swarm-pipeline-infra
tags:
  - plan
  - drone-swarm
  - cli
  - config
  - session-end
  - outbox
  - memory-pipeline
created: 2026-08-10T22:44:00.439Z
updated: 2026-08-22T06:55:15.173Z
---

# Plan: drone-swarm CLI, JSON config files, session-end triggers, beacon outbox

## Summary

Delivers the "roll your own" memory-pipeline infrastructure between session-data collection (built) and memory retrieval (built). Five deliverables: (1) JSON config files for drone-beacon + drone-coordinator (both currently flags-only; coordinator has no file/DB config persistence), (2) session-end trigger hooks (command|spawn, discriminated union) at both layers, (3) `drone-swarm` CLI (standalone REST client: session get/list/log/process/processed + wiki read/search/write), (4) beacon write-behind outbox for fire-and-forget coordinator writes, (5) docs. Deliberately shaped to not block future proactive RAG.

## Config model

Both binaries gain `--config-file <path>`. Resolution: defaults → file → CLI flags (flags win). `sessionEnd` hook (and future hooks) only readable from config file (not expressible via CLI flags) → a hook implies a config file.

Example (~/.drone-coordinator/config.json):
{ "port":3456, "host":"0.0.0.0", "webPort":8080, "webHost":"127.0.0.1", "useHttps":false,
"sessionEnd": { "type":"command", "command":"drone-swarm --coordinator session process {session_id} && /usr/local/bin/my-ingest.sh {session_id}" } }

## Key architecture facts

- Route-prefix divergence: coordinator serves under /api/...; beacon wiki at /wiki/... (no prefix) and only proxies sessions via /sync/sessions/:id. `--beacon` vs `--coordinator` picks both address AND route dialect. Session commands only exist at coordinator; wiki at both.
- Coordinator has NO config persistence (flags + env only via parseArgs in index.ts). Beacon has `beacon_config` table but parseArgs is flags-only. Config file support is net-new for both.
- Session-end insertion points: coordinator `DELETE /api/sync/sessions/:id` (swarm.ts) and beacon proxy `DELETE /sync/sessions/:id` (sync.ts). Coordinator already publishes `session.ended` pubsub event.
- Beacon coordinator-client is entirely fire-and-forget (fetch + log warning on failure); NO durable queue today. createCoordinatorFetch (self-signed TLS tolerant) exists in beacon and should be extracted to drone-swarm-common for drone-swarm reuse.
- Wiki is file-based markdown via drone-swarm-common/wiki-storage.ts (kbDir module global), shared by beacon+coordinator. CLI targets HTTP, not the module directly.
- Spawn: coordinator /api/spawn forwards to beacon; beacon /spawn spawns drone-agent. Default ports: beacon 3457, coordinator 3456 (API) + 8080 (web UI).

## Outbox scope

- THROUGH OUTBOX (fire-and-forget): pushEvents, registerSwarmSession, updateSwarmSessionPersona, endSwarmSession, pushPersona/pushSkill/deletePersona/deleteSkill, pushKnowledge, pushToolDefinitions.
- FAIL-FAST/DROP (request-response or self-healing): spawn (drop + error per user decision — queuing deferred spawns is "spicy"), registerBeacon, pollForApproval, heartbeat, fetchPersonas/fetchSkills/getDefaultHiddenTools, pullKnowledge/searchKnowledge, relayMessage, getSessions/getSessionLog/processSession/completeSessionProcessing, agent-location heartbeats (best-effort, self-heal on reconnect, don't queue stale).

## SessionEndTrigger type (shared)

type SessionEndTrigger =
| { type:'command'; command:string } // {session_id} substituted; shell out, non-blocking, stderr→logger, timeout
| { type:'spawn'; persona:string; beaconId?:string }; // beacon: default self; coordinator: beaconId REQUIRED (config error if missing)
Strictly one-or-the-other (discriminated union).

## Phases

- Phase 1: drone-swarm-common/src/config-file.ts — loadConfigFile (async, clear errors), mergeConfig (shallow top-level, deep-merge sessionEnd). Tests.
- Phase 2: beacon config file + hook. parseArgs async; defaults→file→flags; runSessionEndHook in drone-beacon/src/session-end.ts (command→child_process spawn shell:true w/ {session_id} subst + timeout; spawn→existing spawnAgent). Wire into sync.ts DELETE /sync/sessions/:id (works offline — graceful degradation).
- Phase 3: coordinator config file + hook. Mirror Phase 2; coordinator /api/spawn for spawn-type (forward to beacon). Wire into swarm.ts DELETE /api/sync/sessions/:id after updateSwarmSessionStatus + publishMutationEvent.
- Phase 4: drone-swarm package. package.json bin:{"drone-swarm":"..."}, add to pnpm workspace. address.ts: --beacon/--coordinator mutually exclusive, DRONE_BEACON_URL/DRONE_COORDINATOR_URL, default coordinator→fallback local beacon, route dialect. session.ts + wiki.ts commands. Extract shared TLS-tolerant fetch to drone-swarm-common. JSON stdout for wiki search (extensible to semantic/hybrid). Tests.
- Phase 5: beacon outbox. outbox table (id, kind, endpoint, method, body, createdAt, attempts, lastError, deliveredAt; partial index on undelivered). db/outbox.ts (enqueue/dequeue/markDelivered/markFailed/countPending). coordinator-client write methods enqueue instead of fetch. outbox-flusher.ts interval (reuse syncIntervalMinutes) with backoff + attempt cap. Fail-fast paths stay synchronous. Tests incl. drain-on-reconnect integration, spawn drops+errors when coordinator down.
- Phase 6: docs/agents/memory-pipeline.md — data flow, drone-swarm reference, example bash pipeline (replaces curl+jq), sessionEnd hook config both layers, outbox behavior, note that bootstrap\_\_swarm-memory + coordinator-wiki-librarian remain the opinionated default. Update AGENTS.md structure table + wiki pages.
- Phase 7: validation — LSP zero errors, pnpm -r lint/typecheck/build zero errors, fast test suite passes, manual smoke (config-file command hook fires on session end; drone-swarm session list/log/wiki write/search/read against live coordinator; outbox queues+drains).

## Deferred (explicitly)

Proactive RAG/retrieval injection (future), real-time streaming, drone-agent runtime changes (beacon/coordinator/CLI layer only).

## Decisions locked with user

- CLI binary name: `drone-swarm` (future swarm-management CLI features can live here).
- Address flags: --beacon/--coordinator (mutually exclusive) + DRONE_BEACON_URL/DRONE_COORDINATOR_URL env; auto-fallback to local.
- Config: single --config-file flag; defaults→file→CLI-flag precedence; hooks require a config file.
- SessionEnd: discriminated union, strictly command OR spawn (not both).
- Trigger at BOTH beacon and coordinator layers; most users use coordinator level for shared KB.
- Beacon needs write-behind queue for coordinator-bound messages when connection unavailable.
- Spawn requests: drop + return error, NOT queued.
- Outbox: general-but-simple (all fire-and-forget writes), one table + one flush loop.

## Commits/notes

Monorepo pnpm workspace: drone-agent, drone-core, drone-beacon, drone-coordinator, drone-coordinator-ui, drone-swarm-common, drone-gateway, skill-library. NEW package: drone-swarm.

---

# ✅ EXECUTED 2026-08-21/22 on branch feature/drone-swarm-pipeline-infra

All 7 phases complete. Commits: d52ffca (config-file loader), 2d154cb (beacon config+hook), 107258d (coordinator config+hook), ad23ab4 (drone-swarm package), 24ac364 (outbox), 2f840fa (docs), 3735e6c (help-text repair + flusher scope fix), abf7e29 (cause chaining + prettier), 12c4015 (global fetch pollution fixes).

Implementation deltas vs plan:
- mergeConfig deep-merges sessionEnd ONLY within a matching trigger type; differing shapes replace wholesale (prevents invalid unions like {type:'spawn',command:'x'}).
- Beacon/coordinator parseArgs track explicit flag overrides in a separate object merged AFTER the file so unset flags never beat file values.
- Coordinator spawn trigger REQUIRES beaconId at startup (exit 1 if missing); forwards POST http://<beacon>/spawn with AbortSignal.timeout(10s); unknown beacon → contained error result.
- Outbox schema adds lastAttemptAt column; first attempts are due immediately, retries back off OUTBOX_RETRY_BASE_MS(1s) * 2^(attempts-1); flusher treats 404 as delivered (routes replay-idempotent), drops after maxAttempts (default 10) with error log; injectable clock (`now` option / flushOnce(now)) for tests; interval = min(syncIntervalMinutes*60s, 60s).
- createCoordinatorFetch was NOT moved to drone-swarm-common (Phase 4 delta): drone-swarm targets plain HTTP REST and uses plain fetch (with injectable fetchImpl for tests); the TLS-tolerant fetch stays beacon-local since only beacon↔coordinator traffic is self-signed.
- drone-swarm main(argv, fetchImpl?) exported for testability; entry guard prevents auto-run on import.

Validation results:
- LSP zero errors; pnpm lint/typecheck/build all exit 0 (8 packages).
- Fast suite: 2047 passed | 9 skipped (2056), verified stable across 6 consecutive full runs.
- Smoke A: live coordinator with --config-file command hook fired on DELETE /api/sync/sessions/:id (marker file captured substituted session id); drone-swarm session list/log/process/processed + wiki write/read/search all worked against it.
- Smoke B: outbox held 2 writes while coordinator down (flush → 0 attempted), then delivered both after coordinator up (correct endpoints, 0 pending).

Also fixed en route (pre-existing bugs): mcp-client.test.ts leaked a permanent throwing GUARD_FETCH into globalThis.fetch (now restored in afterAll); migration.test.ts deleted globalThis.fetch in teardown (now saves/restores). Both poisoned every later suite under vitest's single-fork pool — this was the root cause of intermittent drone-swarm cli.test failures ("real fetch must not be called" / "fetch is not a function").

Docs: docs/agents/memory-pipeline.md; AGENTS.md package table (8 packages); project wiki modules/drone-swarm + concepts/memory-pipeline + index entries.
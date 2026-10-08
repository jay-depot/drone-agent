---
tags: [decision, memory-pipeline, config, session-end, outbox, cli]
related:
  [
    concepts/session-processing-pipeline.md,
    concepts/beacon-config-override-spec.md,
    modules/drone-beacon.md,
    decisions/180-swarm-memory-bootstrap-workflow.md,
  ]
---

# 151 — Memory pipeline infrastructure

**Date**: 2026-08-22 · **Status**: Accepted · **Branch**: `feature/drone-swarm-pipeline-infra` (`d52ffca`..`f03b4b8`)

## Context

Session-data collection (events flowing agent → beacon → coordinator) and memory retrieval (personas/skills/wiki syncing back down) were both built, but the bridge between them was opinionated-only: `bootstrap__swarm-memory` generates a curl+jq shell script + systemd timer (_postscript 2026-08-31: this workflow did not actually exist when this ADR was written — the docs referenced a phantom; it now exists as of `feat/swarm-memory-rag@215e429+` as an interactive, confirm-gated setup for the config-file + sessionEnd-trigger + drone-swarm-CLI approach this ADR introduced, not a systemd timer_). Users who wanted different trade-offs had no primitives. Separately, the beacon's coordinator-bound writes were best-effort fire-and-forget — any write attempted while the coordinator was unreachable was silently lost (log warning only).

## Decision

Four primitives, shaped deliberately to not block future proactive RAG:

1. **JSON config files for both servers** (`--config-file <path>`). Resolution is defaults → file → CLI flags; flags win only when explicitly passed, so binaries track explicit flag overrides in a separate object merged _after_ the file. Shared loader in `drone-swarm-common/src/config-file.ts`: strict unknown-key rejection, every validation problem reported at once, path-prefixed errors. Hooks are only expressible in the file (no flag form) — a hook implies a config file.
2. **Session-end triggers** (`sessionEnd`, discriminated union — strictly one variant):
   - `{ type:'command', command }` — `{session_id}` substituted, `/bin/sh -c`, non-blocking, stdout/stderr → server log, 30s timeout, errors contained (never affect the HTTP response).
   - `{ type:'spawn', persona, beaconId? }` — beacon layer defaults `beaconId` to itself (mismatching target → skip with warning); coordinator layer **requires** `beaconId` (startup exit 1 if missing) and forwards `POST /spawn` to that beacon.
     Fired from `DELETE /sync/sessions/:id` (beacon proxy, after the coordinator forward) and `DELETE /api/sync/sessions/:id` (coordinator, after status update + mutation publish).
3. **`drone-swarm` CLI** — standalone REST client replacing curl+jq in pipelines. `--beacon`/`--coordinator` mutually exclusive (+ `DRONE_BEACON_URL`/`DRONE_COORDINATOR_URL`, default local coordinator :3456); the target picks address **and route dialect** (coordinator `/api/*`, beacon flat `/*`). Commands: `session list|log|process|processed`, `wiki read|write|search`. JSON on stdout, errors on stderr exit 1. `main(argv, fetchImpl?)` exported with an entry guard for testability. Notably, the TLS-tolerant `createCoordinatorFetch` was **not** extracted to drone-swarm-common (contrary to the original plan): the CLI targets plain HTTP REST and only beacon↔coordinator traffic is self-signed.
4. **Beacon durable outbox** — SQLite `outbox` table (with `lastAttemptAt`) queues the 12 fire-and-forget coordinator writes; request-response paths stay synchronous fail-fast (spawn drops with an error by design — queuing deferred spawns was judged too surprising). Flusher drains oldest-first (50/batch) on `min(syncIntervalMinutes×60s, 60s)`; retries back off `1s × 2^(attempts-1)`; first attempts are due immediately; 404 counts as delivered because every queued route is idempotent under replay; entries drop after 10 attempts with an error log. Survives beacon restarts.

The opinionated default (`bootstrap__swarm-memory` workflow + the `coordinator-wiki-librarian` persona) remains the recommended path — see memory-pipeline for the full reference.

## Consequences

- Pipeline scripts become one-liners instead of curl+jq incantations; the example bash pipeline in `docs/agents/memory-pipeline.md` is ~10 lines.
- Coordinator-bound writes are now lossless across coordinator downtime and beacon restarts.
- Server config becomes file-versionable; hooks unlock scheduled ingestion without external timers pointing at raw HTTP.
- `mergeConfig` deep-merges `sessionEnd` only within a matching trigger type; differing shapes replace wholesale (prevents invalid unions like `{type:'spawn', command:'x'}`).

## Related

- memory-pipeline · session-processing-pipeline
- [031-session-processing-pipeline](031-session-processing-pipeline.md) · [093-session-status-mismatch-fix](093-session-status-mismatch-fix.md) · [007-beacon-config-underlay](007-beacon-config-underlay.md)

---
key: plan-beacon-cwd-roots
tags:
  - plan
  - beacon
  - cwd-roots
  - spawn
  - coordinator
  - heartbeat
  - completed
created: 2026-09-08T00:19:31.194Z
updated: 2026-09-08T00:32:45.762Z
---

# Plan: Beacon CWD Roots (decision 8) + coordinator↔beacon heartbeat fix

## Status: COMPLETED (2026-09-08, commit 11eda15 on feat/coordinator-ui-sessions)

## Feature
Implement decision 8 of plan-swarm-remote-spawn-lifecycle: beacon-config `spawnRoots`, advertise-and-enforce (MCP-roots style). The beacon advertises its whitelisted working directories to the coordinator (so the coordinator UI launch panel can offer only valid CWD roots), and enforces the whitelist at spawn time. Also folds in a small pre-existing gap: the beacon's `heartbeat()` POSTs to `/api/beacons/:id/heartbeat` but the coordinator has no such route (currently 404s).

## Config shape (locked)
```json
{
  "spawnRoots": {
    "paths": ["/home/user/", "/home/user/Projects/*", "/home/user/Obsidian/*"],
    "default": "/home/user/"
  }
}
```
- `paths`: literal absolute paths and/or `*` glob entries. Globs expand to concrete immediate-child dirs.
- `default`: a literal path that MUST be one of the expanded roots. Validated at load; if not in the set, log a warning and fall back to the first expanded root.
- Config-file only (static for the beacon's lifetime), but with a periodic re-scan that re-expands globs and re-advertises to the coordinator.

## Decisions locked
1. **Enforcement:** `handleSpawnAgent` rejects any `workingDir` not in the expanded root set (400 with clear message). Advertise == enforce by construction.
2. **Default semantics:** `default` must be in the expanded set; validated at load, fallback to first expanded root with a warning. The default does NOT add itself to the list.
3. **Expansion timing:** expand globs at load AND on a periodic re-scan (included now, not deferred). Re-scan re-expands and re-advertises to the coordinator.
4. **Heartbeat fix folded in:** add the missing coordinator `POST /api/beacons/:id/heartbeat` route.

## What was implemented (all phases complete)
- **Phase 1 — config schema:** `SpawnRootsConfig` type + `spawnRoots?` on `ServerConfigFile` + `ALLOWED_KEYS` + `validateSpawnRoots` (paths non-empty string array, default non-empty string, unknown-key rejection) in `drone-swarm-common/src/config-file.ts`.
- **Phase 2 — expansion module:** new `drone-beacon/src/spawn-roots.ts` with `expandSpawnRoots` (glob→immediate child dirs, dedupe, sort), `resolveSpawnRoots` (default validation + fallback w/ warning), `rescanSpawnRoots` (re-expand + change listener), `initSpawnRoots`, `getSpawnRoots`, `getDefaultSpawnRoot`, `isSpawnRootAllowed`, `setSpawnRootsChangeListener`. Module holds in-memory set + default.
- **Phase 3 — enforcement:** `handleSpawnAgent` rejects out-of-whitelist `workingDir` (400 + allowedRoots), defaults to configured default root when omitted.
- **Phase 4 — advertising:** `coordinator-client.registerBeacon` includes `spawnRoots` + `defaultSpawnRoot`; coordinator `beacons` table gained `spawn_roots`/`default_spawn_root` columns (idempotent migration); `db/beacons.ts` row mapping; `GET /beacons` + `GET /beacons/:id` return them; beacon `index.ts` inits spawn roots at startup + periodic re-scan (reuses syncIntervalMinutes) + re-advertise via change listener.
- **Phase 5 — heartbeat fix:** coordinator `POST /api/beacons/:id/heartbeat` → `db.heartbeatBeacon(id)` (404 if missing).
- **Phase 6 — tests + validation:** config-file validation tests, spawn-roots expansion/resolve/enforce tests, spawn-handlers enforcement tests, coordinator heartbeat + spawn-roots-in-response tests. All green: build, typecheck, lint, 2792 tests pass.

## Validation criteria (all met)
- LSP diagnostics clean for all touched files (one pre-existing unrelated error in drone-coordinator/test/beacon-ws.test.ts).
- `pnpm -r run build` and `pnpm typecheck` pass.
- `pnpm lint` passes.
- `pnpm test` (fast suite) passes: 2792 passed / 14 skipped.
- New code covered by unit tests.
- A beacon configured with spawnRoots advertises the expanded set + default to the coordinator; GET /api/beacons returns them.
- handleSpawnAgent rejects a workingDir outside the whitelist with a 400.
- The coordinator's POST /api/beacons/:id/heartbeat route works (no more 404).
- Periodic re-scan re-expands globs and re-advertises.

## Notes
- The coordinator↔beacon heartbeat gap was NOT in project memory — a fresh finding this session. Folded into this plan's Phase 5.
- This plan's output feeds `plan-coordinator-ui-launch-interact` (which assumes GET /api/beacons returns spawnRoots + defaultSpawnRoot).

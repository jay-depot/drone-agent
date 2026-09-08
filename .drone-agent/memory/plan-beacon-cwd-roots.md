---
key: plan-beacon-cwd-roots
tags:
  - plan
  - beacon
  - cwd-roots
  - spawn
  - coordinator
  - heartbeat
created: 2026-09-08T00:19:31.194Z
updated: 2026-09-08T00:19:31.194Z
---

# Plan: Beacon CWD Roots (decision 8) + coordinator↔beacon heartbeat fix

## Feature
Implement decision 8 of plan-swarm-remote-spawn-lifecycle: beacon-config `spawnRoots`, advertise-and-enforce (MCP-roots style). The beacon advertises its whitelisted working directories to the coordinator (so the coordinator UI launch panel can offer only valid CWD roots), and enforces the whitelist at spawn time. Also folds in a small pre-existing gap: the beacon's `heartbeat()` POSTs to `/api/beacons/:id/heartbeat` but the coordinator has no such route (currently 404s).

## Config shape (locked)
```json
{
  "spawnRoots": {
    "paths": [
      "/home/user/",
      "/home/user/Projects/*",
      "/home/user/Obsidian/*"
    ],
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

## Architecture facts (verified)
- Shared spawner (drone-swarm-common/src/spawner.ts) accepts arbitrary workingDir, length-bounded only (MAX_WORKING_DIR_LENGTH=4096), passed via config.workingDir → --working-dir + cwd. No whitelist.
- handleSpawnAgent (drone-beacon/src/routes/spawn-handlers.ts) validates persona but NOT workingDir.
- Beacon config-file: drone-swarm-common/src/config-file.ts ServerConfigFile (strict ALLOWED_KEYS + validateConfigFile). Beacon reads via --config-file in drone-beacon/src/index.ts parseArgs.
- Coordinator GET /api/beacons returns id/name/host/port/connected/trustStatus/publicKey/verificationCode — no spawn roots.
- Coordinator is stateless relay (ADR 43); beacon pushes to coordinator via coordinator-client (registerBeacon, pushPersona, etc.). Beacon pulls from coordinator during triggerCoordinatorSync.
- Beacon heartbeat(): coordinator-client.ts POSTs /api/beacons/:id/heartbeat; coordinator beacons.ts has NO such route (404 gap).
- Coordinator db/beacons.ts: registerBeacon/getBeacon/listBeacons/heartbeatBeacon; schema in db/init.ts.

## Steps

### Phase 1 — Config schema (drone-swarm-common)
1. `drone-swarm-common/src/config-file.ts`: add `SpawnRootsConfig` type `{ paths: string[]; default: string }`. Add `spawnRoots?: SpawnRootsConfig` to `ServerConfigFile`. Add `'spawnRoots'` to ALLOWED_KEYS. Add validation: paths is non-empty string array; default is a non-empty string; reject unknown keys inside spawnRoots.

### Phase 2 — Expansion module (drone-beacon)
2. New `drone-beacon/src/spawn-roots.ts`:
   - `expandSpawnRoots(paths: string[]): string[]` — for each entry, if it ends with `/*`, expand to immediate child dirs (fs.readdir, filter dirs, absolute); else keep literal. Dedupe, sort.
   - `resolveSpawnRoots(cfg: SpawnRootsConfig): { roots: string[]; defaultRoot: string }` — expand, validate default ∈ roots, else warn + fallback to roots[0].
   - `rescanSpawnRoots()` — re-expand and update the in-memory set + re-advertise to coordinator (see Phase 4). Returns the new set.
   - Module holds the current expanded set + default in memory.

### Phase 3 — Enforcement (drone-beacon)
3. `drone-beacon/src/routes/spawn-handlers.ts`: in `handleSpawnAgent`, if `config.workingDir` is provided, check it is in the expanded root set; if not, return 400 `{ error: 'workingDir not in spawnRoots whitelist' }`. If not provided, default to the beacon's defaultSpawnRoot (or process.cwd() fallback).

### Phase 4 — Advertising to coordinator
4. `drone-beacon/src/coordinator-client.ts`: `registerBeacon` includes `spawnRoots: string[]` + `defaultSpawnRoot: string` in the POST /api/beacons body.
5. `drone-coordinator/src/db/init.ts`: add `spawn_roots TEXT` (JSON array) + `default_spawn_root TEXT` columns to `beacons` (idempotent migration).
6. `drone-coordinator/src/db/beacons.ts`: add spawnRoots/defaultSpawnRoot to Beacon type, registerBeacon, getBeacon, listBeacons, row mapping.
7. `drone-coordinator/src/routes/beacons.ts`: GET /beacons and GET /beacons/:id return spawnRoots + defaultSpawnRoot.
8. `drone-beacon/src/index.ts`: at startup, resolve spawn roots from config and pass to spawn-roots module; call rescanSpawnRoots() on the periodic interval (reuse syncIntervalMinutes or a new interval).

### Phase 5 — Heartbeat fix (folded in)
9. `drone-coordinator/src/routes/beacons.ts`: add `POST /api/beacons/:id/heartbeat` → `db.heartbeatBeacon(id)`; 404 if not found, else return the updated beacon.

### Phase 6 — Tests + validation
10. Unit tests: config-file validation (spawnRoots shape, unknown keys); expandSpawnRoots (literal, glob, dedupe, missing dir); resolveSpawnRoots (default in set, default not in set → fallback + warn); handleSpawnAgent enforcement (in-whitelist ok, out-of-whitelist 400); coordinator heartbeat route; coordinator beacon response includes spawnRoots.
11. LSP must pass; `pnpm -r run lint` and `pnpm -r run build` pass; `pnpm -r run test` (fast suite) passes.

## Validation criteria
- LSP diagnostics clean (typescript connected).
- `pnpm -r run lint` and `pnpm -r run build` pass with zero errors.
- `pnpm -r run test` (fast suite) passes.
- New code covered by unit tests.
- A beacon configured with spawnRoots advertises the expanded set + default to the coordinator; GET /api/beacons returns them.
- handleSpawnAgent rejects a workingDir outside the whitelist with a 400.
- The coordinator's POST /api/beacons/:id/heartbeat route works (no more 404).
- Periodic re-scan re-expands globs and re-advertises.

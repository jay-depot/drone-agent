---
tags: [beacon, spawn, cwd-roots, coordinator, heartbeat, adr]
related: [drone-beacon.md, drone-coordinator.md, drone-swarm-common.md, concepts/spawn-backend.md]
---

# Beacon CWD Roots (decision 8) + coordinator↔beacon heartbeat fix

**Summary**: Implements decision 8 of the remote-spawn lifecycle plan — beacon-config `spawnRoots`, advertise-and-enforce (MCP-roots style). The beacon advertises its whitelisted working directories to the coordinator (so the coordinator UI launch panel can offer only valid CWD roots) and enforces the whitelist at spawn time. Also folds in a small pre-existing gap: the beacon's `heartbeat()` POSTs to `/api/beacons/:id/heartbeat` but the coordinator had no such route (it 404'd).

## Context

The remote-spawn lifecycle plan (project-memory plan `plan-swarm-remote-spawn-lifecycle`) locked decision 8: beacon-config `spawnRoots`, advertise-and-enforce. The shared spawner (`drone-swarm-common/src/spawner.ts`) accepted an arbitrary `workingDir` — length-bounded only (`MAX_WORKING_DIR_LENGTH = 4096`), no whitelist. `handleSpawnAgent` validated persona but not `workingDir`. The coordinator's `GET /api/beacons` returned no spawn roots, so a future UI launch panel could not offer only valid CWD choices.

Separately, the beacon's `coordinator-client.ts` `heartbeat()` POSTs to `/api/beacons/:id/heartbeat`, but the coordinator's `beacons.ts` routes had no such route — the call silently 404'd. This was a fresh finding (not previously documented in project memory).

## Decision

### Config shape (config-file only)

```json
{
  "spawnRoots": {
    "paths": ["/home/user/", "/home/user/Projects/*", "/home/user/Obsidian/*"],
    "default": "/home/user/"
  }
}
```

- `paths`: literal absolute paths and/or `*` glob entries. Globs expand to concrete immediate-child dirs.
- `default`: a literal path that MUST be one of the expanded roots. Validated at load; if not in the set, log a warning and fall back to the first expanded root. The default does NOT add itself to the list.
- Config-file only (static for the beacon's lifetime), but with a periodic re-scan that re-expands globs and re-advertises to the coordinator.

### Enforcement (advertise == enforce by construction)

`handleSpawnAgent` rejects any `workingDir` not in the expanded root set with a 400 (`{ error, allowedRoots }`). When `workingDir` is omitted, it defaults to the beacon's configured default root.

### Advertising to the coordinator

The coordinator is a stateless relay (ADR 43) that cannot call beacons inbound, so the beacon PUSHES its spawn roots at registration: `registerBeacon` includes `spawnRoots` + `defaultSpawnRoot` in the `POST /api/beacons` body. The coordinator stores them on the beacon row (`spawn_roots` JSON array + `default_spawn_root` columns, idempotent migration) and returns them from `GET /beacons` + `GET /beacons/:id`. Re-registration (`INSERT OR REPLACE`) updates them if the beacon restarts with different config.

### Periodic re-scan

A periodic interval (reusing `syncIntervalMinutes`) re-expands globs and, via a change listener, re-advertises to the coordinator — so newly-created project dirs become available without a beacon restart.

### Heartbeat fix

Added the missing coordinator `POST /api/beacons/:id/heartbeat` route → `db.heartbeatBeacon(id)` (404 if missing). The beacon's existing heartbeat call now lands.

## Implementation

- `drone-swarm-common/src/config-file.ts` — `SpawnRootsConfig` type + `spawnRoots?` on `ServerConfigFile` + `ALLOWED_KEYS` + `validateSpawnRoots` (paths non-empty string array, default non-empty string, unknown-key rejection).
- `drone-beacon/src/spawn-roots.ts` (new) — `expandSpawnRoots` (glob → immediate child dirs, dedupe, sort), `resolveSpawnRoots` (default validation + fallback w/ warning), `rescanSpawnRoots` (re-expand + change listener), `initSpawnRoots`, `getSpawnRoots`, `getDefaultSpawnRoot`, `isSpawnRootAllowed`, `setSpawnRootsChangeListener`. Module holds the in-memory set + default.
- `drone-beacon/src/routes/spawn-handlers.ts` — enforcement in `handleSpawnAgent` (400 out-of-whitelist, default to configured root when omitted).
- `drone-beacon/src/coordinator-client.ts` — `registerBeacon` advertises `spawnRoots` + `defaultSpawnRoot`.
- `drone-coordinator/src/db/init.ts` — `spawn_roots`/`default_spawn_root` columns + idempotent migration.
- `drone-coordinator/src/db/beacons.ts` — row mapping.
- `drone-coordinator/src/routes/beacons.ts` — `GET /beacons` + `GET /beacons/:id` return spawn roots; new `POST /beacons/:id/heartbeat`.
- `drone-beacon/src/index.ts` — init spawn roots at startup + periodic re-scan + re-advertise via change listener.

## Tests

- `drone-swarm-common/test/config-file.test.ts` — spawnRoots validation (valid, non-object, empty paths, empty default, unknown key).
- `drone-beacon/test/spawn-roots.test.ts` — expand (literal/glob/dedupe/missing dir), resolve (default in set / not in set → fallback + warn), init + enforcement helpers.
- `drone-beacon/test/spawn-handlers.test.ts` — enforcement (in-whitelist ok, out-of-whitelist 400, default-to-configured-root).
- `drone-coordinator/test/routes/beacons.test.ts` — heartbeat route (200 + 404), spawn roots in `GET /beacons` response.

Validation: LSP clean on all touched files, `pnpm -r run build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (2792 passed / 14 skipped).

## Key Points

- **Advertise == enforce by construction** — the UI only offers valid roots, and the spawner refuses anything else.
- **Default does NOT add itself** — it must be in the expanded set; fallback to first root with a warning (avoids human/agent error).
- **Coordinator is a stateless relay** — spawn roots are pushed at registration and cached on the beacon row, not pulled.
- **Heartbeat gap was a fresh finding** — the beacon's heartbeat call 404'd because the coordinator had no route.

## Related

- `plan-swarm-remote-spawn-lifecycle` — the remote-spawn lifecycle plan (project memory) that locked decision 8
- [[drone-beacon]] — the beacon module
- [[drone-coordinator]] — the coordinator module
- [[decisions/200-beacon-spawnroots-trust-path]] — follow-up: the trust-path registration branch dropped the roots fields this ADR added; fixed with merge-on-omit re-registration
- [[drone-swarm-common]] — the shared config-file loader
- [[concepts/spawn-backend]] — spawn backend concept

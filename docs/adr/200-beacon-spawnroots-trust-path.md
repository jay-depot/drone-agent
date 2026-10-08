---
tags: [coordinator, beacon, spawn-roots, registration, adr]
related: [drone-coordinator.md, drone-beacon.md]
---

# Beacon spawnRoots lost on trust-path registration + merge-on-omit re-registration

**Summary**: Fixes the coordinator bug where `POST /api/beacons` dropped `spawnRoots`/`defaultSpawnRoot` whenever the body carried a `publicKey` — the trust path, which every real beacon takes (`registerBeacon` in `drone-beacon/src/coordinator-client.ts` always sends `publicKey` + `tlsFingerprint`). The route rebuilt the `db.registerBeacon` call from `{ id, name, host, port }` only, so every registration and periodic re-advertise wrote NULL roots into the beacons table (`INSERT OR REPLACE`), and the coordinator UI launch panel showed "No roots advertised" even for correctly configured beacons. The fix threads the roots through the trust branch and adds merge-on-omit semantics to `db.registerBeacon`: an omitted roots field preserves the existing row's value; a present field (including explicit `[]` / `''`) overwrites.

## Context

ADR 197 added beacon-config `spawnRoots` with advertise-and-enforce: the beacon pushes `spawnRoots` + `defaultSpawnRoot` in its registration body, and the coordinator stores them on the beacon row for `GET /beacons` (consumed by the New Session launch panel). While testing the remote launch UI (ADR 198), the panel showed "No roots advertised" for a correctly configured host.

Tracing the chain found the drop point: the coordinator's `POST /beacons` route has two branches. The legacy branch (no `publicKey`) passes `request.body` straight to `db.registerBeacon` — roots survive. The trust branch (`publicKey` present) builds a narrow `RegisterBeaconTrustRequest` for the trust table and then calls `db.registerBeacon({ id, name, host, port })` — reconstructing the payload from a subset and discarding the roots fields. Because the route test for ADR 197 exercised only the legacy branch (no `publicKey` payload), the suite stayed green while every production registration nulled the roots.

The bug also exposed a design fragility: `db.registerBeacon` is a blind `INSERT OR REPLACE`, so any future caller that re-registers without roots would erase a working advertisement even with the route fixed.

## Decision

1. **Trust branch passes roots through** — the trust branch's `db.registerBeacon` call includes `spawnRoots: request.body.spawnRoots` and `defaultSpawnRoot: request.body.defaultSpawnRoot`. `RegisterBeaconRequest` already carried both fields; no type changes.
2. **Merge-on-omit in `db.registerBeacon`** — before the `INSERT OR REPLACE`, the function reads the existing row and resolves `spawnRoots: req.spawnRoots ?? existing?.spawnRoots` (same for `defaultSpawnRoot`). Rationale: the coordinator is a passive cache of beacon-pushed state (ADR 43 stateless-relay style); a partial re-registration must not erase state it did not send. The beacon always sends both fields, so a beacon that genuinely clears its roots can still overwrite with an explicit value.
   - Alternative considered and rejected: a single-statement UPSERT with `COALESCE(excluded.x, x)` rewrites SQL semantics for all callers for no behavioral gain.
3. **Non-goals held** — no beacon changes (config load, glob expansion, and the advertise body were verified correct); no required UI changes.

## Implementation

- `drone-coordinator/src/routes/beacons.ts` — trust branch forwards `spawnRoots`/`defaultSpawnRoot` to `db.registerBeacon`.
- `drone-coordinator/src/db/beacons.ts` — `registerBeacon` reads the existing row first and applies merge-on-omit for the two roots fields; the `INSERT OR REPLACE` statement is unchanged.

## Tests

- `drone-coordinator/test/routes/beacons.test.ts` — trust-path registration with roots returns them from `GET /beacons` (the regression test; demonstrated failing pre-fix: `expected undefined to deeply equal ['/home/user/']`); trust-path re-registration without roots preserves the advertised roots; trust-path re-registration with new roots replaces them.
- `drone-coordinator/test/db.test.ts` — db-level merge semantics: re-register without roots preserves; re-register with new roots replaces; fresh registration without roots leaves both fields undefined.

## Key Points

- **A route that rebuilds a request body from a subset silently drops fields** — when threading a new field through a route with multiple branches, every branch that reconstructs the payload must be swept, and tests must cover the branch production actually takes (here: trust path, because real beacons always present a `publicKey`).
- **Merge-on-omit protects cached beacon-pushed state** — `INSERT OR REPLACE` plus a partial payload is a data-loss footgun for passive caches; absent-fields-preserve is the safe default when the owner (the beacon) always sends full state.
- **The beacon side was correct** — config load, glob expansion, and the advertise body needed no changes.

## Related

- [197-beacon-cwd-roots](197-beacon-cwd-roots.md) — introduced `spawnRoots` advertise-and-enforce; its route test covered only the legacy registration branch
- [drone-coordinator](../../drone-coordinator/) — the coordinator module (routes + db)
- [198-coordinator-ui-launch-interact](198-coordinator-ui-launch-interact.md) — the launch panel that surfaced the symptom

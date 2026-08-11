---
key: db-migrations-system-deferred
tags:
  - db
  - migrations
  - architecture
  - deferred
  - drone-beacon
  - drone-coordinator
created: 2026-08-11T23:25:22.559Z
updated: 2026-08-11T23:25:22.559Z
---

# Deferred: formal schema-migration system for beacon/coordinator

## Context (2026-08-11)

While fixing a bug where the coordinator web UI never showed a pending beacon's
bidirectional verification code, we discovered the underlying cause was schema
evolution fragility, not just a logic bug.

## Root cause of the "code never shows" bug

`drone-coordinator/src/db/beacon-trust.ts` `registerBeaconTrust()` only computes
and persists `verification_code` on a beacon's FIRST-ever registration. The
re-registration path (runs on every beacon/coordinator restart) does an `UPDATE`
touching only `host, port, tls_fingerprint, updated_at` — it never recomputes or
writes `verification_code`. For any `beacon_trust` row created before the column
existed (or re-registered since), `verification_code` stays NULL, maps to `''`,
and the web UI's `{beacon.verificationCode && ...}` guard renders nothing.

## Current migration approach (what we have today)

- Both `drone-beacon/src/db/init.ts` and `drone-coordinator/src/db/init.ts`
  create schema idempotently via `CREATE TABLE IF NOT EXISTS`.
- Column additions are ad-hoc `ALTER TABLE` blocks guarded by hand-written
  `PRAGMA table_info(...)` checks (e.g. `lastExamined`, `verification_code`,
  dropping `approval_token`).
- No schema versioning. No `PRAGMA user_version`. No migration registry.
- `drone-gateway` uses a matrix-js-sdk `MigrationState` in a `crypto_meta` table
  (a different, SDK-coupled mechanism) — not a reusable pattern.
- `drone-swarm-common/src/db-helpers.ts` already exists as the natural shared
  home for a migration runner.

## Decision: DEFERRED

For now we fix only the re-registration path (recompute + persist
`verification_code` on re-registration). We are NOT building a migration system
in this change.

## Open question to pick up later

How formal should the migration system be?

- **Option A — Minimal versioned runner:** shared `runMigrations(db, migrations)`
  helper in `drone-swarm-common/src/db-helpers.ts`, `PRAGMA user_version` tracks
  schema version, per-package ordered migration lists run in a transaction. Fold
  existing ad-hoc ALTER TABLE blocks into versioned migrations. No new deps.
- **Option B — Heavier framework:** on-disk migration files, up/down framework,
  `--migrate` CLI subcommand, migrations registry table (Rails/Knex-style). More
  moving parts, more maintenance surface.

Given the project's "minimalist core" principle and both DBs being single-file
better-sqlite3 with a handful of tables, **Option A** was the lean recommendation,
but the user deferred the whole question.

## When to revisit

Next time schema evolution breaks an upgrade (a column/table added post-release
not appearing on existing installs). Prefer a versioned runner before it bites a
second time.
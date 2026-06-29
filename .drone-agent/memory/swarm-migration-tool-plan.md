---
key: swarm-migration-tool-plan
tags:
  []
created: 2026-06-29T01:37:23.468Z
updated: 2026-06-29T19:28:01.361Z
---

# Part 4: Local-to-Swarm Migration Tool

## Summary

A CLI tool for promoting identity assets (personas, skills, insights, principles) and wiki pages between scopes. Lives as a `drone-agent migrate` subcommand with a thin `drone-migrate` bin stub. Memory migration is deferred. Conversation log import is a phase 5 concern.

## Scope of Migratable Assets

| Asset      | Local scopes  | Swarm scopes                                |
| ---------- | ------------- | ------------------------------------------- |
| Personas   | project, user | beacon, coordinator                         |
| Skills     | project, user | beacon, coordinator                         |
| Insights   | project, user | beacon, coordinator                         |
| Principles | project, user | beacon, coordinator                         |
| Wiki pages | (n/a)         | beacon, coordinator (server-to-server only) |

**NOT included:** Memory (different storage model, deferred). Conversation logs (phase 5).

## CLI Design

### Entry Point

- Subcommand: `drone-agent migrate <options>`
- Bin stub: `drone-migrate` (thin `.js` stub calling the same entrypoint)
- Migration service: `drone-agent/src/runtime/migration-service.ts`

### Beacon Discovery

- Reads `swarm.beaconHost` and `swarm.beaconPort` from `.drone-agent/config.json`
- Overridable via `--beacon-host` and `--beacon-port` flags
- If neither config nor flags are provided: **helpful error** (no silent defaults, no `localhost:3457` fallback)

### Commands

```bash
# List all migrate-able assets across all scopes
drone-migrate --list

# Promote specific asset to higher scope
drone-migrate --type persona --id "my-persona" --to beacon
drone-migrate --type skill --id "deploy-helm" --to coordinator
drone-migrate --type insight --id "target-id" --to beacon
drone-migrate --type principle --id "target-id" --to coordinator

# Batch promote all of one type from one scope to another
drone-migrate --type persona --from user --to beacon
drone-migrate --type skill --from project --to beacon

# Demote (pull down) swarm assets to local
drone-migrate --pull --type persona --scope coordinator --to user
drone-migrate --pull --type skill --scope beacon --to project

# Wiki pages (server-to-server only, no local scope)
drone-migrate --type wiki --id "page-id" --to coordinator
drone-migrate --pull --type wiki --id "page-id" --scope coordinator --to beacon
```

### Operation Flags

- **Default**: Copy (source stays in place)
- `--move`: Move (source deleted after successful copy to target)
- `--backup-to <path>`: Backup source asset as raw file to specified path before copying/moving. The backup is just the raw asset file on disk — for local assets, it's the file as-is; for swarm assets, it's fetched from the server and written to disk. Can be dropped right back into `~/.drone-agent/` if something goes wrong.

### Scope Flags

- `project` — current project only
- `user` — all projects for this user
- `beacon` / `local` — all agents on this host
- `coordinator` / `swarm` — entire swarm

## Migration Mechanics

### Local → Swarm (Promotion)

1. Read asset from local filesystem (`.drone-agent/` or `~/.drone-agent/`)
2. If `--backup-to`, write raw file to backup path
3. POST asset to beacon endpoint (e.g., `POST /personas` for persona promotion to beacon)
4. If promoting to coordinator, beacon proxies to coordinator
5. If `--move`, delete local source file after successful copy

### Swarm → Local (Demotion, `--pull`)

1. GET asset from beacon endpoint (beacon serves local + proxied coordinator)
2. Write asset to local filesystem at target scope
3. If `--move`, DELETE from server via beacon endpoint
4. If `--backup-to`, write fetched content to backup path before writing to target

### Swarm → Swarm (e.g., beacon → coordinator)

1. GET asset from beacon (source scope)
2. POST to beacon with target scope specified (beacon proxies to coordinator)
3. If `--move`, DELETE from source scope via beacon

## Server Endpoints Needed

### Beacon

- Existing: `/personas`, `/skills` CRUD (already exist)
- Existing: `/insights`, `/principles` CRUD (already exist)
- Existing: `/wiki` CRUD (already exist)

### Coordinator

- Existing: `/personas`, `/skills` CRUD
- Existing: `/insights`, `/principles` CRUD (already exist)
- Existing: `/wiki` CRUD (already exist)

## Files Created/Modified

### drone-agent

- `src/cli.ts` — added `migrate` subcommand parsing (detected before `--` options)
- `src/migrate.ts` — CLI entry point with formatted output
- `src/runtime/migration-service.ts` (new) — asset promotion/demotion logic, beacon HTTP calls, filesystem operations, backup
- `bin/drone-migrate` (new) — thin stub
- `package.json` — added `drone-migrate` bin entry
- `src/index.tsx` — added `migrate` invocation handler (early return before engine init)

### drone-core

- `src/config-types.ts` — added `beaconHost`/`beaconPort` to `DroneSwarmConfig` and `PartialDroneAgentConfig`
- `src/config-schema.ts` — added `beaconHost`/`beaconPort` to schema

### Tests

- `drone-agent/test/migration.test.ts` — 25 tests covering list, promote, demote, move, backup, batch, error cases, CLI parsing, and resolveBeaconAddress

## Validation Criteria (all met)

- All LSP checks pass (pre-existing errors only)
- `pnpm typecheck` passes (pre-existing test type errors only)
- `pnpm lint` passes
- `pnpm test` passes (549 tests, 36 test files)
- `drone-migrate --list` shows all migratable assets across scopes
- Promoting a persona from project to beacon copies it to beacon (POST /personas)
- `--move` deletes the source after successful promotion
- `--backup-to` writes the raw asset file to the specified path
- `--pull --scope coordinator --to user` fetches from beacon (proxied to coordinator) and writes to `~/.drone-agent/`
- Batch promotion (`--from user --to beacon`) moves all assets of a type
- Helpful error when no beacon config or flags provided
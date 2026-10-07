---
tags: [decision, migration, cli, swarm]
related: [concepts/local-to-swarm-migration.md, architecture/swarm-architecture.md, entities/DroneAgentConfig.md]
---

# Decision: Local-to-Swarm Migration Tool

**Summary**: A standalone CLI tool (`drone-migrate`) for promoting and demoting identity assets (personas, skills, insights, principles) and wiki pages between local and swarm scopes.

## Context

As the swarm system matures, users need a way to move assets between scopes:

- **Promote**: Take a persona or skill developed locally (project or user scope) and make it available swarm-wide (beacon or coordinator scope)
- **Demote**: Pull a swarm-wide asset down to local scope for editing or offline use
- **Backup**: Save a copy of an asset before migrating it
- **Batch**: Move all assets of a given type at once

The migration tool needs to work without a running agent engine — it should be a standalone CLI that can be invoked directly or as a `drone-agent migrate` subcommand.

## Decision

We built a standalone migration tool with the following design:

### Entry Points

- **Subcommand**: `drone-agent migrate <options>` — integrated into the main CLI
- **Bin stub**: `drone-migrate` — thin `.js` stub for standalone use

The bin stub was initially a dead import (it imported the module but never called any function). This was fixed in commit `fced563` — it now prepends `'migrate'` to `process.argv` and calls `parseCliArgs`, which routes to `parseMigrateSubcommand`. When `kind === 'migrate'`, it calls `runMigrate()` with the parsed options.

### Architecture

The migration logic lives in `drone-agent/src/runtime/migration-service.ts` as a set of exported async functions. The CLI entry point (`drone-agent/src/migrate.ts`) parses options, loads config, and calls the service. The main `index.tsx` entry point detects the `migrate` invocation kind and returns early before engine initialization — no plugin engine needed.

### Beacon Discovery

- Reads `swarm.beaconHost` and `swarm.beaconPort` from `.drone-agent/config.json`
- Overridable via `--beacon-host` and `--beacon-port` flags
- If neither config nor flags are provided: **helpful error** (no silent defaults)

### Migration Mechanics

**Local → Swarm (Promotion)**:
1. Read asset from local filesystem (`.drone-agent/` or `~/.drone-agent/`)
2. If `--backup-to`, write raw file to backup path
3. POST asset to beacon endpoint (e.g., `POST /personas`)
4. If promoting to coordinator, beacon proxies to coordinator
5. If `--move`, delete local source file after successful copy

**Swarm → Local (Demotion, `--pull`)**:
1. GET asset from beacon endpoint
2. Write asset to local filesystem at target scope
3. If `--move`, DELETE from server via beacon endpoint
4. If `--backup-to`, write fetched content to backup path before writing to target

**Swarm → Swarm (e.g., beacon → coordinator)**:
1. GET asset from beacon (source scope)
2. POST to beacon with target scope specified (beacon proxies to coordinator)
3. If `--move`, DELETE from source scope via beacon

### Asset Types Supported

| Asset | Local scopes | Swarm scopes | Notes |
|-------|-------------|--------------|-------|
| Personas | project, user | beacon, coordinator | .md files with YAML frontmatter |
| Skills | project, user | beacon, coordinator | .md files with YAML frontmatter |
| Insights | project, user | beacon, coordinator | JSON arrays |
| Principles | project, user | beacon, coordinator | JSON arrays |
| Wiki pages | (n/a) | beacon, coordinator | Server-to-server only |

### Not Included

- **Memory**: Different storage model (SQLite at beacon, JSON at agent), deferred to a future phase
- **Conversation logs**: Phase 5 concern

### CLI Flags

```
--list                          List all migratable assets
--type <type>                   Asset type (persona|skill|insight|principle|wiki)
--id <id>                       Specific asset id to migrate
--from <scope>                  Source scope (project|user|beacon|coordinator)
--to <scope>                    Target scope (beacon|coordinator|project|user)
--move                          Delete source after successful copy
--backup-to <path>              Backup asset file before migrating
--pull                          Pull from swarm to local (demote)
--scope <scope>                 Source scope for pull operations
--beacon-host <host>            Beacon host override
--beacon-port <port>            Beacon port override
```

## Consequences

- **Positive**: Users can now promote locally-developed personas and skills to the swarm without manual HTTP calls
- **Positive**: The `--backup-to` flag provides a safety net for destructive operations
- **Positive**: Batch operations make it easy to migrate all assets at once
- **Positive**: The tool works standalone without a running agent engine
- **Positive**: The bin stub was fixed in commit `fced563` — it now properly parses CLI args and calls `runMigrate()` instead of silently exiting
- **Tradeoff**: The migration service duplicates some HTTP logic from `coordinator-client.ts` — a future refactor could extract a shared HTTP client library
- **Tradeoff**: Wiki pages are server-to-server only (beacon ↔ coordinator), so they can't be promoted from local scope

## Related

- local-to-swarm-migration — Concept page with usage examples
- swarm-architecture — Swarm architecture overview
- [DroneAgentConfig](../../drone-core/src/config-types.ts) — Config schema with beaconHost/beaconPort

---
tags: [decision]
related: [config-cascade.md, DroneAgentConfig.md]
---

# ADR 005: Layered Config with Last-Write-Wins

**Status**: Accepted (2026-06-18)

## Context

Configuration needed to be sourced from multiple levels (default, user, project, beacon, coordinator) with clear override semantics.

## Decision

Use a layered config cascade with last-write-wins per key, except the named-entry maps (`enabledPlugins`, `providers`, `trustedPlugins`, `lsp.servers`, `mcp.servers`) which shallow-merge entry-by-entry (see ADR 251).

## Rationale

- **Simplicity**: Last-write-wins is easy to understand and debug
- **Predictability**: No deep merge surprises
- **Project-first**: Project-level config overrides user-level, enabling project-specific settings
- **Merged maps**: `enabledPlugins` is a sparse override map over the default plugin base; a more-local layer names only what it adds or removes

## Consequences

- Config files live in `.drone-agent/config.json` at each scope
- Config loader walks up the directory tree looking for `.drone-agent/` directories
- Beacon and coordinator config values are injected as underlays via `DroneConfigInjector`
- `enabledPlugins` is a `Record<string, boolean>` override map (`true`/`false`/absent)

## Related

- config-cascade — Config layering
- [DroneAgentConfig](../../drone-core/src/config-types.ts) — Config schema

---
tags: [decision]
related: [config-cascade.md, DroneAgentConfig.md]
---

# ADR 005: Layered Config with Last-Write-Wins

**Status**: Accepted (2026-06-18)

## Context

Configuration needed to be sourced from multiple levels (default, user, project, beacon, coordinator) with clear override semantics.

## Decision

Use a layered config cascade with last-write-wins per key, except `enabledPlugins` which is additive at the project level.

## Rationale

- **Simplicity**: Last-write-wins is easy to understand and debug
- **Predictability**: No deep merge surprises
- **Project-first**: Project-level config overrides user-level, enabling project-specific settings
- **Additive plugins**: Project plugins are added to user plugins, not replacing them

## Consequences

- Config files live in `.drone-agent/config.json` at each scope
- Config loader walks up the directory tree looking for `.drone-agent/` directories
- Beacon and coordinator config values are injected as underlays via `DroneConfigInjector`
- Only the user level and below can specify loaded plugins

## Related

- [[config-cascade]] — Config layering
- [[entities/DroneAgentConfig]] — Config schema

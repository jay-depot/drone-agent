---
tags:
  - decision
  - swarm
related:
  - beacon-config-architecture.md
  - config-cascade.md
---

# ADR 007: Beacon Config as Underlay via Injector Hooks

**Status**: Accepted (2026-06-25)

## Context

The beacon needed a way to inject configuration values into connected agents. Options included: beacon config overrides agent config (overlay), or beacon config provides defaults that agent config overrides (underlay).

## Decision

Beacon config operates as an **underlay** — it provides defaults that the agent's local config can override. Implemented via a `ConfigInjector` hook system.

## Rationale

- **Most local wins**: The agent's local config (project/user) should always win over beacon-provided values
- **Underlay semantics**: Beacon provides host-specific defaults (model URLs, environment settings) that the agent can override
- **Hook system**: `ConfigInjector` interface with priority-based ordering allows multiple injectors (beacon, coordinator) to compose

## Implementation

- `ConfigInjector` interface with `id`, `priority`, `inject()`, and optional `onConfigChanged()`
- `BeaconConfigInjector` class in swarm plugin fetches config from beacon's `/config` endpoint
- Priority order: System Defaults (0) → Coordinator (50) → Beacon (75) → Agent Local (100)
- Beacon config cached on disconnect, re-fetched on reconnect

## Consequences

- Beacon config is always an underlay, never overrides agent config
- Config injectors are composable and priority-ordered
- Beacon config is cached for offline resilience
- Config changes can be propagated via events

## Related

- [config-cascade](005-config-cascade.md) — Config layering
- beacon-config-override-spec — Original spec

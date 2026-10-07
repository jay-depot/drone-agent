---
tags: [decision]
related: [broker-provider.md, identity-assets.md, decisions/029-dynamic-writer-registration.md]
---

# ADR 003: Broker + Provider Pattern for Skills and Personas

**Status**: Accepted (2026-06-22), extended with writers (2026-06-30)

## Context

Skills and personas needed to be sourced from multiple locations (project, user, beacon, coordinator) with a clear precedence order. Additionally, creation workflows needed a way to write new assets to the appropriate storage backend without hardcoding scope choices.

## Decision

Use a two-layer architecture: **broker plugin** manages the list of providers, **provider plugins** read from disk and feed skills/personas to the broker. Provider plugins also register **writers** for creating new assets.

## Rationale

- **Separation of concerns**: Brokers handle routing and deduplication; providers handle storage
- **Pluggable sources**: New provider types (e.g., HTTP API, database) can be added without changing the broker
- **Precedence**: Providers are sorted by precedence (lower number = higher priority)
- **Duplicate resolution**: Duplicate IDs are resolved by the highest-precedence provider
- **Dynamic scope discovery**: Writers are registered alongside providers, so creation workflows can discover available scopes at runtime

## Consequences

- Broker plugins: `skills`, `persona`
- Provider plugins: `skill-provider-project`, `skill-provider-user`, `persona-provider-project`, `persona-provider-user`
- Swarm plugin registers additional providers and writers at beacon and coordinator levels
- Providers are sorted by precedence; lower number wins for conflicts
- Writers are sorted by scope order (project → user → beacon → coordinator) for consistent UI
- Creation workflows (`persona__create`, `skills__create`) dynamically discover scopes from registered writers

## Related

- [[broker-provider]] — Pattern details
- [[identity-assets]] — Personas and skills
- [[decisions/029-dynamic-writer-registration]] — Writer registration extension

---
tags:
  - decision
  - swarm
related:
  - self-improvement.md
  - swarm-architecture.md
---

# ADR 013: Swarm-Wide Insights and Principles Promotion

**Status**: Accepted (2026-06-28)

## Context

The self-improvement system (insights and principles) was file-based and local-only. For swarm-scoped personas and skills, insights and principles needed to be stored on the owning server (beacon/coordinator) rather than local files.

## Decision

Make the self-improvement plugin a **storage broker** that delegates to provider-registered storage engines. Beacon and coordinator each gain separate `insights` and `principles` tables.

## Rationale

- **Scope-aware**: Insights for local assets go to files; swarm assets go to the owning server
- **Broker pattern**: Mirrors the existing persona/skill broker+provider architecture
- **Server storage**: Beacon and coordinator have their own tables, not shared with knowledge
- **Coordinator proxy**: Beacon proxies coordinator-scoped requests when connected

## Implementation

- `insights` and `principles` tables on both beacon and coordinator
- REST endpoints: CRUD for both, with `?scope=coordinator` proxy on beacon
- Self-improvement plugin refactored to broker pattern with storage engine registration
- Swarm plugin registers HTTP storage engines for beacon/coordinator
- Principle injection prompt fragment reads from all relevant providers

## Consequences

- Swarm-scoped insights/principles are stored on the owning server
- Local-scoped assets continue to use file-based storage
- Coordinator proxy gracefully no-ops when no coordinator is connected
- Principles are injected into system prompt from all relevant scopes

## Related

- self-improvement — Self-improvement system
- swarm-architecture — Swarm mode
- [003-broker-provider](003-broker-provider.md) — Broker pattern

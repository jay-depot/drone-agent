---
tags:
  - decision
  - swarm
related:
  - drone-beacon.md
  - memory.md
---

# ADR 011: Beacon-Level Memory Store with TTL

**Status**: Accepted (2026-06-23)

## Context

The beacon needed a shared memory store for inter-agent state. Three models were considered: event log (append-only), KV store with TTL, and vector store.

## Decision

Start with a **KV store with TTL** for beacon-level memory. Simple, predictable, and useful for inter-agent communication.

## Rationale

- **Simplicity**: KV store is easy to implement and reason about
- **TTL**: Automatic expiration prevents stale data accumulation
- **Namespaces**: Agent-scoped isolation via namespace field
- **Extensibility**: Can be extended with event log and vector store later

## Implementation

- `memory` table: `id`, `key`, `value` (JSON), `namespace`, `ttl`, timestamps
- REST endpoints: CRUD + get by key
- Lazy expiration on read + periodic cleanup
- Namespaced keys like `swarm:project:name:key`

## Consequences

- Simple, predictable shared memory for agents
- TTL-based automatic cleanup
- Namespace isolation between agents
- Event log and vector store deferred to future phases

## Related

- [drone-beacon](../../drone-beacon/) — Beacon implementation
- [006-sqlite-over-plugins](006-sqlite-over-plugins.md) — SQLite decision

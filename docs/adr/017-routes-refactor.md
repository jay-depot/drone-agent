---
tags:
  - decision
  - swarm
related:
  - drone-beacon.md
  - drone-coordinator.md
---

# ADR 017: Routes Refactor — Domain-Specific Route Files

**Status**: Accepted (2026-06-28)

## Context

The `routes.ts` files in both `drone-beacon` (1132 lines) and `drone-coordinator` (808 lines) had grown large and unwieldy.

## Decision

Split the monolithic `routes.ts` files into per-domain route files under a `routes/` directory.

## Rationale

- **Maintainability**: Smaller, focused files are easier to understand and modify
- **Discoverability**: Route handlers are organized by domain (personas, skills, agents, etc.)
- **Merge conflicts**: Reduced conflicts when multiple people work on different route groups
- **Pattern**: Each route file exports a default function that takes the Fastify instance

## Implementation

- Beacon: 13 route files (health, personas, skills, agents, memory, messages, spawn, config, events, insights, principles, wiki, sync) + context.ts for shared state
- Coordinator: 9 route files (health, personas, skills, beacons, knowledge, insights, principles, wiki, swarm, messages) + index.ts
- Shared state (coordinator client, beacon address) extracted to `context.ts`
- Proxy helpers extracted to `context.ts`

## Consequences

- Route handlers are organized by domain
- Shared state is centralized in `context.ts`
- No behavioral changes — pure structural refactor
- Easier to add new route domains in the future

## Related

- [[drone-beacon]] — Beacon implementation
- [[drone-coordinator]] — Coordinator implementation

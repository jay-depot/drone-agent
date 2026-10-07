---
tags: [decision]
related: [swarm-architecture.md, entities/Persona.md, broker-provider.md]
---

# 034: Swarm Persona Contents and System Prompt Injection Fix

**Status**: Implemented (2026-07-01)

## Context

The swarm plugin's `reloadFromBeacon()` did a raw type cast from the beacon's JSON response to `DronePersonaDefinition[]`. The beacon returns `Persona[]` objects (with `systemPrompt: string` containing the full `.md` content), but the cast tells TypeScript to treat them as `DronePersonaDefinition[]` (which expects `systemPromptOverride?: string`). Since `systemPromptOverride` is optional, TypeScript doesn't error — but the value is silently lost. The full `.md` content stored in `systemPrompt` is never parsed to extract `systemPromptOverride`, `promptFragments`, `uiColor`, `allowedTools`, `allowedSkills`, or `toolCallLimit`.

Additionally, the beacon's POST `/personas` route hardcoded `'local'` as the scope, so coordinator-scoped persona writes were stored with the wrong scope.

## Decision

Three changes:

1. **Parse `.md` content in swarm reload**: Import `parsePersonaMd()` from the persona loader and use it to parse the `.md` content from the beacon's `systemPrompt` field, extracting all rich fields. Preserve the scope from the database (not from the `.md` frontmatter).

2. **Accept scope in beacon POST**: The beacon's POST `/personas` route now accepts an optional `scope` field from the request body, defaulting to `'local'` when absent. This allows the coordinator writer's `scope: 'coordinator'` to be honored.

3. **Add scope to `CreatePersonaRequest`**: Added an optional `scope?: 'local' | 'coordinator'` field to the `CreatePersonaRequest` type in `drone-core/src/domain-types.ts`.

## Consequences

- **Positive**: Swarm personas now correctly inject their `systemPromptOverride`, `promptFragments`, `uiColor`, `allowedTools`, `allowedSkills`, and `toolCallLimit` into the system prompt
- **Positive**: Coordinator-scoped persona writes are stored with the correct scope
- **Positive**: The fix is minimal — just adding `parsePersonaMd()` calls and a scope field
- **Negative**: None identified

## Implementation

- `drone-agent/src/plugins/swarm/index.ts` — Imported `parsePersonaMd()`, replaced raw type cast with proper parsing
- `drone-beacon/src/routes/personas.ts` — Accept optional `scope` field from request body
- `drone-core/src/domain-types.ts` — Added `scope` to `CreatePersonaRequest`

## Related

- [Persona](../../drone-core/src/domain-types.ts) — Persona definition with rich fields
- broker-provider — Broker + provider pattern
- swarm-architecture — Swarm mode

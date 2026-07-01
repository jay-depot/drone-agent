---
key: plan-dynamic-writer-registration
tags:
  []
created: 2026-07-01T02:28:18.449Z
updated: 2026-07-01T02:43:35.235Z
---

# Plan: Dynamic Writer Registration for Persona & Skills Creation

## Summary

Implemented dynamic writer registration for persona and skills creation workflows. The `persona__create` and `skills__create` workflows now query the broker capability's `getWriters()` to dynamically build scope choices, instead of hardcoding `'project'` and `'user'`.

## What was done

1. Added `DronePersonaWriter` and `DroneSkillWriter` types to `drone-core/src/provider-types.ts` with `exists`, `writePersona`/`writeSkill`, `scope`, `label`, and `id` fields
2. Extended `DronePersonaCapability` and `DroneSkillsCapability` with `registerWriter`, `unregisterWriter`, `getWriters` methods
3. Implemented writer management in both broker plugins (sorted by scope order: project, user, beacon, coordinator)
4. Added writers to all four file-based provider plugins (persona-provider-project, persona-provider-user, skill-provider-project, skill-provider-user)
5. Added beacon and coordinator writers to the swarm plugin (POST to beacon's REST API)
6. Updated persona wizard to query `getWriters()` for dynamic scope choices and delegate writes to the selected writer
7. Updated skills wizard to query `getWriters()` for dynamic scope choices and delegate writes to the selected writer
8. Updated tests to provide mock writers via capabilities

## Validation

- `pnpm typecheck` passes (only pre-existing test errors)
- `pnpm lint` passes (only pre-existing errors in drone-swarm-common)
- `pnpm test` passes — 47 test files, 807 tests, all passing

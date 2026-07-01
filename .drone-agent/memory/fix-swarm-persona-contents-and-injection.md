---
key: fix-swarm-persona-contents-and-injection
tags:
  []
created: 2026-07-01T21:55:38.061Z
updated: 2026-07-01T21:59:27.709Z
---

# Fix Swarm Persona Contents and System Prompt Injection

## Summary

Fixed two bugs in the swarm persona system, both stemming from a type mismatch between the persistence layer (`Persona` with `systemPrompt`) and the runtime layer (`DronePersonaDefinition` with `systemPromptOverride`). Also fixed a scope hardcoding issue in the beacon's POST route.

## Root Cause

The swarm plugin's `reloadFromBeacon()` did a raw type cast:
```typescript
const personasData = (await personasResp.json()) as DronePersonaDefinition[];
```

The beacon returns `Persona[]` objects (with `systemPrompt: string`), but the cast tells TypeScript to treat them as `DronePersonaDefinition[]` (which expects `systemPromptOverride?: string`). Since `systemPromptOverride` is optional, TypeScript doesn't error — but the value is silently lost. The full `.md` content stored in `systemPrompt` is never parsed to extract `systemPromptOverride`, `promptFragments`, `uiColor`, `allowedTools`, `allowedSkills`, or `toolCallLimit`.

## Changes Made

### 1. `drone-agent/src/plugins/swarm/index.ts`
- Imported `parsePersonaMd` from `../persona/loader.js`
- In `reloadFromBeacon()`, replaced the raw type cast with a properly typed intermediate type, then mapped each response through `parsePersonaMd()` to extract all rich fields
- Preserved the scope from the DB (not from the `.md` frontmatter)

### 2. `drone-beacon/src/routes/personas.ts`
- Changed the POST `/personas` route to accept an optional `scope` field from the request body, defaulting to `'local'` when absent
- This allows the coordinator writer's `scope: 'coordinator'` to be honored

### 3. `drone-core/src/domain-types.ts`
- Added optional `scope?: 'local' | 'coordinator'` field to `CreatePersonaRequest`

## Validation

- `pnpm typecheck` passes (all 4 workspace packages compile cleanly; pre-existing errors in test file only)
- `pnpm lint:prettier` passes
- Pre-existing lint errors in `drone-swarm-common/src/tls.ts` are unrelated

## Remaining

- Step 5 (manual validation) is pending — requires running `drone-agent --workflow persona__create` targeting coordinator scope and verifying `persona__list` shows correct `hasOverride`, `fragmentCount`, and `uiColor`, then selecting the persona and checking `/systemprompt` includes the persona's content.

---
key: fix-swarm-persona-contents-and-injection
tags: []
created: 2026-07-01T21:55:38.061Z
updated: 2026-07-01T21:55:38.061Z
---

# Fix Swarm Persona Contents and System Prompt Injection

## Summary

Two bugs in the swarm persona system, both stemming from a type mismatch between the persistence layer (`Persona` with `systemPrompt`) and the runtime layer (`DronePersonaDefinition` with `systemPromptOverride`). A third issue (scope hardcoding in the beacon's POST route) prevents coordinator-scoped writes from working correctly.

## Root Cause

The swarm plugin's `reloadFromBeacon()` does a raw type cast:

```typescript
const personasData = (await personasResp.json()) as DronePersonaDefinition[];
```

The beacon returns `Persona[]` objects (with `systemPrompt: string`), but the cast tells TypeScript to treat them as `DronePersonaDefinition[]` (which expects `systemPromptOverride?: string`). Since `systemPromptOverride` is optional, TypeScript doesn't error — but the value is silently lost. The full `.md` content stored in `systemPrompt` is never parsed to extract `systemPromptOverride`, `promptFragments`, `uiColor`, `allowedTools`, `allowedSkills`, or `toolCallLimit`.

## Plan

### Step 1: Parse `.md` content in swarm persona reload

**File:** `drone-agent/src/plugins/swarm/index.ts`

**What:** In `reloadFromBeacon()`, instead of raw type casting, import and use `parsePersonaMd()` from the persona loader to parse the `systemPrompt` field (which contains the full `.md` content with YAML frontmatter).

**Why:** This is the minimal, backward-compatible fix. The wizard already stores the full `.md` content (with frontmatter) as `systemPrompt` in the DB. Parsing it on read-back extracts all the rich fields (`systemPromptOverride`, `promptFragments`, `uiColor`, etc.) into the proper `DronePersonaDefinition` shape.

**Details:**

1. Import `parsePersonaMd` from `../persona/loader.js` (relative path from swarm plugin to persona plugin)
2. In `reloadFromBeacon()`, after fetching personas from the beacon, map each response through `parsePersonaMd()`:

```typescript
// Before (broken):
const personasData = (await personasResp.json()) as DronePersonaDefinition[];

// After (fixed):
import { parsePersonaMd } from '../persona/loader.js';

const rawPersonas = (await personasResp.json()) as Array<{
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  scope: string;
}>;

for (const p of rawPersonas) {
  // Parse the .md content to extract all rich fields
  const definition = parsePersonaMd(p.id, p.systemPrompt);
  // Preserve the scope from the DB (not from the .md frontmatter)
  definition.scope = p.scope === 'coordinator' ? 'coordinator' : 'beacon';

  if (p.scope === 'coordinator') {
    coordinatorPersonas.set(p.id, definition);
  } else {
    beaconPersonas.set(p.id, definition);
  }
}
```

3. Also update the `(p as any).scope` check to use the properly typed `p.scope` field.

### Step 2: Accept `scope` field in beacon's POST `/personas` route

**File:** `drone-beacon/src/routes/personas.ts`

**What:** Change the route handler to accept an optional `scope` field from the request body, defaulting to `'local'` when absent.

**Why:** The coordinator writer sends `scope: 'coordinator'` in the POST body, but the route hardcodes `'local'`. This means coordinator-scoped personas are stored as local on the beacon, and the swarm plugin's scope-splitting logic puts them in the wrong bucket.

**Details:**

```typescript
// Before:
const persona = db.createPersona(request.body, 'local');

// After:
const scope =
  (request.body as any).scope === 'coordinator' ? 'coordinator' : 'local';
const persona = db.createPersona(request.body, scope);
```

### Step 3: Update `CreatePersonaRequest` type to include optional `scope`

**File:** `drone-core/src/domain-types.ts`

**What:** Add an optional `scope` field to `CreatePersonaRequest`.

**Why:** Makes the type system reflect reality — the coordinator writer already sends this field, and the beacon route should accept it.

**Details:**

```typescript
export type CreatePersonaRequest = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  scope?: 'local' | 'coordinator';
};
```

### Step 4: Verify the fix

**What:** Run the project's typecheck and lint to ensure no regressions.

**Commands:**

```bash
pnpm typecheck
pnpm lint
```

### Step 5: Manual validation

**What:** Run the persona creation workflow targeting the coordinator scope and verify:

1. The persona appears in `persona__list` with correct `hasOverride`, `fragmentCount`, and `uiColor`
2. After selecting the persona with `/persona select <id>`, the `/systemprompt` command shows the persona's content
3. The persona's `systemPromptOverride` and `promptFragments` are injected into the system prompt

## Validation Criteria

- [ ] `pnpm typecheck` passes with no errors
- [ ] `pnpm lint` passes with no errors
- [ ] After creating a persona via `--workflow persona__create` targeting coordinator scope, `persona__list` shows `hasOverride: true`, correct `fragmentCount`, and correct `uiColor`
- [ ] After selecting the persona, `/systemprompt` includes the persona's brief and fragments
- [ ] The beacon's SQLite DB stores coordinator-scoped personas with `scope: 'coordinator'` (not `'local'`)

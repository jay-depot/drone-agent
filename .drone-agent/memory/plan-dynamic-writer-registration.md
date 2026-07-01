---
key: plan-dynamic-writer-registration
tags:
  []
created: 2026-07-01T02:28:18.449Z
updated: 2026-07-01T02:28:18.449Z
---

# Plan: Dynamic Writer Registration for Persona & Skills Creation

## Summary

Currently, the `persona__create` and `skills__create` workflows hardcode two scope choices (`'project'` and `'user'`) in their `askScope` functions, and write directly to the filesystem. The swarm plugin already registers read-side providers for beacon and coordinator scopes, but the creation workflows don't know about them.

This plan adds a **writer registration** mechanism to the `DronePersonaCapability` and `DroneSkillsCapability` interfaces. Each provider plugin (project, user, swarm) registers a writer alongside its existing read provider. The creation workflows then query the capability for available writers and present them dynamically, delegating the actual write to the selected writer.

## Design

### New types in `drone-core/src/provider-types.ts`

```typescript
export type DronePersonaWriter = {
  id: string;
  scope: 'project' | 'user' | 'beacon' | 'coordinator';
  label: string;
  writePersona: (id: string, content: string) => Promise<{ filePath: string }>;
};

export type DroneSkillWriter = {
  id: string;
  scope: 'project' | 'user' | 'beacon' | 'coordinator';
  label: string;
  writeSkill: (id: string, content: string) => Promise<{ filePath: string }>;
};
```

### Capability extensions in `drone-core/src/persona-types.ts` and `drone-core/src/capabilities.ts`

Add to `DronePersonaCapability`:
```typescript
registerWriter: (writer: DronePersonaWriter) => void;
unregisterWriter: (writerId: string) => void;
getWriters: () => DronePersonaWriter[];
```

Add to `DroneSkillsCapability`:
```typescript
registerWriter: (writer: DroneSkillWriter) => void;
unregisterWriter: (writerId: string) => void;
getWriters: () => DroneSkillWriter[];
```

### Broker plugin changes

**`persona/index.ts`**: Add an internal `writers` array, `insertWriterSorted`, `removeWriter`, and wire up the three new capability methods. Writers are sorted by precedence (same as providers) so the UI order is consistent.

**`skills/index.ts`**: Same pattern — `writers` array, sorted insertion, three new capability methods.

### Provider plugin changes

**`persona-provider-project/index.ts`**: Register a `DronePersonaWriter` with scope `'project'` that writes to `.drone-agent/personas/<id>/persona.md`.

**`persona-provider-user/index.ts`**: Register a `DronePersonaWriter` with scope `'user'` that writes to `~/.drone-agent/personas/<id>/persona.md`.

**`skill-provider-project/index.ts`**: Register a `DroneSkillWriter` with scope `'project'` that writes to `.drone-agent/skills/<id>.md`.

**`skill-provider-user/index.ts`**: Register a `DroneSkillWriter` with scope `'user'` that writes to `~/.drone-agent/skills/<id>.md`.

**`swarm/index.ts`**: Register two writers each for personas and skills:
- Beacon writer (scope `'beacon'`): POSTs to `{baseUrl}/personas` or `{baseUrl}/skills`
- Coordinator writer (scope `'coordinator'`): POSTs to `{baseUrl}/personas` or `{baseUrl}/skills` with scope metadata

### Wizard changes

**`persona/wizard.ts`**:
- `askScope` now queries `ctx.requestCapability<DronePersonaCapability>('persona')` and calls `cap.getWriters()` to build the choices dynamically
- The write step delegates to the selected writer's `writePersona()` instead of writing directly to the filesystem
- The `inputScope` type broadens from `'project' | 'user'` to `string` (any valid scope)
- The `inputSchema` `scope` description updates to reflect dynamic scopes

**`skills/wizard.ts`**:
- Same pattern: `askScope` queries `cap.getWriters()`, delegates write to the selected writer
- `inputScope` broadens to `string`

### Test changes

**`persona-wizard.test.ts`** and **`skills-wizard.test.ts`**:
- Update `makeContext` to provide a mock capability with `getWriters` returning test writers
- Add tests for dynamic scope discovery (e.g., only project writer available → only one choice)
- Add tests for beacon/coordinator writer selection
- Existing tests for project/user scopes continue to work with the new mock setup

## Step-by-step implementation

### Step 1: Add writer types to drone-core

**Files**: `drone-core/src/provider-types.ts`, `drone-core/src/index.ts`

Add `DronePersonaWriter` and `DroneSkillWriter` types to `provider-types.ts`. Export them from `index.ts`.

### Step 2: Extend capability interfaces

**Files**: `drone-core/src/persona-types.ts`, `drone-core/src/capabilities.ts`

Add `registerWriter`, `unregisterWriter`, `getWriters` to both `DronePersonaCapability` and `DroneSkillsCapability`.

### Step 3: Implement writer management in broker plugins

**Files**: `drone-agent/src/plugins/persona/index.ts`, `drone-agent/src/plugins/skills/index.ts`

Add internal writer arrays, sorted insertion, and wire up the three new capability methods. Writers are sorted by precedence (same as providers).

### Step 4: Add writers to file-based provider plugins

**Files**: 
- `drone-agent/src/plugins/persona-provider-project/index.ts`
- `drone-agent/src/plugins/persona-provider-user/index.ts`
- `drone-agent/src/plugins/skill-provider-project/index.ts`
- `drone-agent/src/plugins/skill-provider-user/index.ts`

Each registers a writer alongside its existing provider. The writer's `writePersona`/`writeSkill` method creates the directory (if needed) and writes the file.

### Step 5: Add writers to swarm plugin

**File**: `drone-agent/src/plugins/swarm/index.ts`

Register beacon and coordinator writers for both personas and skills. The writers POST to the beacon's REST API (`POST /personas` or `POST /skills`). The beacon writer sends scope `'local'`, the coordinator writer sends scope `'coordinator'`.

### Step 6: Update persona wizard

**File**: `drone-agent/src/plugins/persona/wizard.ts`

- Rewrite `askScope` to query `getWriters()` from the persona capability
- Map writers to elicit choices (using `writer.label` for the label, `writer.scope` for the value)
- Replace direct filesystem write with `writer.writePersona(id, content)`
- Update `PersonaCreateInput` type: `scope` becomes `string` (not just `'project' | 'user'`)
- Update `inputSchema` description for `scope`
- Remove `resolveLogger` (no longer needed for file-path warnings since the writer handles that)
- Remove `resolvePersonaCapability` (replaced by using the full capability with `getWriters`)

### Step 7: Update skills wizard

**File**: `drone-agent/src/plugins/skills/wizard.ts`

- Same pattern as Step 6: rewrite `askScope`, delegate write to writer
- Update `SkillsCreateInput` type: `scope` becomes `string`
- Update `inputSchema` description for `scope`

### Step 8: Update tests

**Files**: `drone-agent/test/persona-wizard.test.ts`, `drone-agent/test/skills-wizard.test.ts`

- Update `makeContext` to provide mock capabilities with `getWriters` returning appropriate test writers
- Add tests for dynamic scope discovery
- Add tests for beacon/coordinator writer selection
- Ensure existing tests still pass

### Step 9: Type-check and lint

Run `pnpm typecheck` and `pnpm lint` to verify everything compiles and passes linting.

### Step 10: Run tests

Run `pnpm test` to verify all tests pass.

## Validation criteria

1. `pnpm typecheck` passes with no errors
2. `pnpm lint` passes with no errors
3. `pnpm test` passes — all existing tests continue to work
4. The persona wizard's `askScope` dynamically shows only the scopes for which writers are registered
5. The skills wizard's `askScope` dynamically shows only the scopes for which writers are registered
6. When only project and user providers are enabled, the wizard shows exactly those two choices (backward compatible)
7. When the swarm plugin is also enabled, the wizard shows four choices: project, user, beacon, coordinator
8. Writing to beacon scope via the persona wizard POSTs to the beacon's `/personas` endpoint
9. Writing to coordinator scope via the skills wizard POSTs to the beacon's `/skills` endpoint with coordinator scope

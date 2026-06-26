---
key: type-deduplication-plan
tags:
  - refactoring
  - types
  - drone-core
created: 2026-06-26T02:41:08.193Z
updated: 2026-06-26T02:41:08.193Z
---

## Plan: Type Deduplication (Item #3)

### Step 1: Fix the bug

Add missing `scope` field to `drone-coordinator/src/types.ts`:

- `Persona` → add `scope: 'local' | 'coordinator'`
- `Skill` → add `scope: 'local' | 'coordinator'`

### Step 2: Move shared types to drone-core

Export from `drone-core/src/index.ts`:

- `Persona` (canonical persistence type)
- `Skill`
- `CreatePersonaRequest`
- `CreateSkillRequest`

### Step 3: Update imports

Both `drone-beacon` and `drone-coordinator` import from `drone-core` instead of defining locally.

### Effort: Low-Medium

- Types only, no runtime changes
- No breaking API changes

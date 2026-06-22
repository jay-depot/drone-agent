---
key: persona-directory-restructure-plan
tags:
  - plan
  - persona
  - skills
  - insights
  - restructure
created: 2026-06-22T18:16:10.828Z
updated: 2026-06-22T18:16:10.828Z
---

# Plan: Restructure Persona Directory Layout

## Summary
Move persona files from flat `personas/<name>.md` to `personas/<name>/persona.md` with subdirectories for persona-owned skills and insights.

## Current Layout
```
.drone-agent/
├── personas/
│   ├── coder.md
│   └── reviewer.md
├── skills/
│   └── ...
└── insights/
    ├── persona/
    │   └── coder.json
    ├── skill/
    │   └── ...
    └── project/
        └── ...
```

## New Layout
```
.drone-agent/
├── personas/
│   ├── coder/
│   │   ├── persona.md
│   │   ├── skills/
│   │   │   └── ...
│   │   └── insights/
│   │       └── insights.json
│   └── reviewer/
│       ├── persona.md
│       ├── skills/
│       └── insights/
├── skills/
│   └── ...
└── insights/
    ├── skill/
    │   └── ...
    └── project/
        └── ...
```

## Steps (in order)

### Step 1: Update `loadPersonasFromDir` in `persona/loader.ts`
- Change from reading `*.md` files directly to listing subdirectories and reading `persona.md` inside each
- Use `readdir(dir, { withFileTypes: true })` to filter directories
- Skip subdirectories that don't contain a `persona.md`

### Step 2: Update persona-owned skills loading in `persona-provider-project/index.ts`
- Change from loading skills from `personas/skills/` to iterating over loaded personas and loading from `personas/<id>/skills/`
- For each persona with `skillIds`, load skills from their personal `skills/` subdirectory

### Step 3: Update persona-owned skills loading in `persona-provider-user/index.ts`
- Same change as Step 2 but for user-level personas

### Step 4: Update `personaCreateWorkflow` in `persona/wizard.ts`
- Change the target file path from `personas/<id>.md` to `personas/<id>/persona.md`
- Update the `mkdir` call to create the persona subdirectory (already recursive)

### Step 5: Update `self-improvement/index.ts` for persona insights
- Change persona insight path from `insights/persona/<id>.json` to `personas/<id>/insights/insights.json`
- Use the persona capability to resolve the base directory (project vs user)
- Keep skill and project insight paths unchanged

### Step 6: Update `persona-loader.test.ts`
- Update test file paths to use the new subdirectory structure
- Create `personas/<id>/persona.md` instead of `personas/<id>.md`

### Step 7: Update `persona-wizard.test.ts`
- Update expected file paths in assertions
- Update test setup to create `personas/<id>/persona.md` where needed

### Step 8: Update `self-improvement.test.ts`
- Update expected insight file paths for persona targets
- Keep skill and project insight path assertions unchanged

### Step 9: Update log messages in `persona/index.ts`
- Update the log message that mentions `~/.drone-agent/personas/` and `.drone-agent/personas/` to reflect the new structure (cosmetic)

## Dependencies
- Steps 1-5 are independent of each other (they change different files)
- Steps 6-8 depend on steps 1, 4, 5 respectively (tests must match implementation)
- Step 9 is cosmetic and can be done last

## Files to modify
1. `drone-agent/src/plugins/persona/loader.ts`
2. `drone-agent/src/plugins/persona-provider-project/index.ts`
3. `drone-agent/src/plugins/persona-provider-user/index.ts`
4. `drone-agent/src/plugins/persona/wizard.ts`
5. `drone-agent/src/plugins/self-improvement/index.ts`
6. `drone-agent/test/persona-loader.test.ts`
7. `drone-agent/test/persona-wizard.test.ts`
8. `drone-agent/test/self-improvement.test.ts`
9. `drone-agent/src/plugins/persona/index.ts` (cosmetic log message)

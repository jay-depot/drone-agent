---
key: drone-agent-refactor-plan
tags:
  - refactoring
  - drone-agent
  - cleanup
  - completed
created: 2026-06-24T06:35:53.591Z
updated: 2026-06-24T06:52:56.456Z
---

# Refactoring Plan: drone-agent/src/index.tsx

## Problem
The file has grown to 869 lines and needs to be broken up into focused modules.

## Current Structure
The file contains several distinct responsibilities:
1. **CLI argument parsing** - `parseCliArgs` (lines ~57-142)
2. **Output handlers** - `makePlainOutputEventHandler`, `makeJsonOutputEventHandler` (lines ~220-250)
3. **Elicitation** - `createReadlineElicitation` (lines ~262-330)
4. **Interactive loop** - `runInteractiveLoop` (lines ~332-400)
5. **First-run setup** - `runFirstRunSetup`, `pickModelInteractive` (lines ~660-800)
6. **Main entry** - `main` function (lines ~402-660)

## Proposed Split

```
drone-agent/src/
├── index.tsx          # Just the main() entry point (~150 lines)
├── cli.ts             # CLI types + parseCliArgs (~100 lines)
├── elicitation.ts    # createReadlineElicitation (~70 lines)
├── output-handlers.ts # Plain/JSON output handlers (~30 lines)
├── first-run.ts      # First-run setup + model picker (~140 lines)
└── runtime/
    └── ... (existing)
```

## Implementation Order
1. CLI types + parseCliArgs → `cli.ts`
2. Output handlers → `output-handlers.ts`
3. Elicitation → `elicitation.ts`
4. First-run setup + pickModelInteractive → `first-run.ts`
5. Refactor index.tsx to import from new modules

## Notes
- Each module should export its types and functions for testability
- Maintain existing exports for test compatibility: `parseCliArgs as parseCliInvocation`, `createReadlineElicitation`
- The main() function will become the orchestrator that imports from these modules

---

## Execution Summary (2026-06-24)

### Completed Refactoring

Successfully refactored `index.tsx` (869 lines) into the following modules:

1. **`cli.ts`** - CLI types (`CliOptions`, `CliInvocation`) and `parseCliArgs()` function (~140 lines)

2. **`output-handlers.ts`** - `makePlainOutputEventHandler()` and `makeJsonOutputEventHandler()` (~45 lines)

3. **`elicitation.ts`** - `createReadlineElicitation()` function (~70 lines)

4. **`first-run.tsx`** - `runFirstRunSetup()` and `pickModelInteractive()` (~170 lines, uses JSX so .tsx extension)

5. **`interactive.ts`** - `runInteractiveLoop()` and `buildPromptLabel()` (~110 lines)

6. **`index.tsx`** - Main entry point now imports from new modules (~270 lines)

### Verification
- All TypeScript compiles without errors (`npx tsc --noEmit`)
- Maintains backward compatibility exports: `parseCliArgs as parseCliInvocation`, `createReadlineElicitation`

### Files Created/Modified
- Created: `cli.ts`, `output-handlers.ts`, `elicitation.ts`, `first-run.tsx`, `interactive.ts`
- Modified: `index.tsx` (rewritten to import from new modules)
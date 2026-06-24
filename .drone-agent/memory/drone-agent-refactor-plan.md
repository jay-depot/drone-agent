---
key: drone-agent-refactor-plan
tags:
  - refactoring
  - drone-agent
  - cleanup
created: 2026-06-24T06:35:53.591Z
updated: 2026-06-24T06:35:53.591Z
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
---
tags: [decision, macros, bug-fix]
related:
  [
    decisions/045-macro-event-streaming-unified-hooks.md,
    modules/drone-agent-plugins.md,
  ]
---

# ADR 086: Macro Argument Re-use Fix

**Status**: Implemented (commit `df439c5`)

## Problem

The macro parser's `substituteMacroArgs` function had a bug where argument substitution mutated the shared `argSpec` array. When the same `$1` placeholder appeared in multiple steps of a macro, the second substitution would fail because the first substitution had already consumed the argument.

## Root Cause

The `substituteMacroArgs` function in `drone-agent/src/plugins/macros/parser.ts` used `argSpec.shift()` to consume arguments. Since `argSpec` is a reference to the macro's shared definition, the first step's substitution permanently removed entries from the array, leaving subsequent steps with no arguments to substitute.

## Solution

Changed `argSpec.shift()` to `argSpec[index]` (index-based access) so the argument array is never mutated during substitution. Each step independently reads its arguments without affecting other steps.

## Files Changed

- `drone-agent/src/plugins/macros/parser.ts` — Changed `shift()` to index-based access
- `drone-agent/src/plugins/macros/index.ts` — Minor refactoring (types extraction)
- `drone-agent/src/plugins/macros/types.ts` — Extracted `DroneMacroStep` and `DroneMacroDefinition` types from `plugin-system.ts` to the macros plugin

## Validation

- All existing macro tests pass
- Manual test: macro with `$1` in multiple steps now works correctly
- LSP clean, build passes, lint passes

---
key: plan-compaction-buildfragment-required
tags:
  - compaction
  - plan
  - type-safety
  - refactor
created: 2026-08-18T00:16:26.803Z
updated: 2026-08-18T00:16:26.803Z
---

# Plan: Fix `buildFragmentMessages` Type Consistency

## Summary

Make `buildFragmentMessages` a required dependency in both `CompactionPluginDeps` and `RegistrationContext` types, removing the defensive `??` fallback since all callers already provide it.

## Files to Modify

### `drone-agent/src/plugins/compaction/index.ts`

**Change A - Line ~452:** Update `CompactionPluginDeps` type

```typescript
// BEFORE:
buildFragmentMessages?: () => Promise<DroneChatMessage[]>;  // optional

// AFTER:
buildFragmentMessages: () => Promise<DroneChatMessage[]>;  // required
```

**Change B - Line ~456:** Update JSDoc to remove "Defaults to" language

```typescript
// BEFORE:
/**
 * Build the list of system messages from registered prompt fragments.
 * Used to account for fragment tokens in context-window calculations.
 * Defaults to returning an empty array if not provided.
 */

// AFTER:
/**
 * Build the list of system messages from registered prompt fragments.
 * Used to account for fragment tokens in context-window calculations.
 */
```

**Change C - Line ~493:** Remove the `??` fallback in plugin registration

```typescript
// BEFORE:
buildFragmentMessages: deps.buildFragmentMessages ?? (async () => []),

// AFTER:
buildFragmentMessages: deps.buildFragmentMessages,
```

## Validation Criteria

- [ ] `pnpm -r run build` passes
- [ ] `pnpm -r run lint` passes
- [ ] `pnpm test` passes (all compaction tests already provide the dep)
- [ ] Zero LSP errors on `drone-agent/src/plugins/compaction/index.ts`

## Notes

- No test changes needed - all existing tests already provide `buildFragmentMessages: async () => []`
- The wire-up in `drone-agent/src/index.tsx` already provides it unconditionally
- This is a **contract clarification**, not a behavioral change

## Status

Plan created 2026-08-17. Ready for execution.

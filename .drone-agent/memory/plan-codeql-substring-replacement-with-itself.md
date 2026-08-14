---
key: plan-codeql-substring-replacement-with-itself
tags: []
created: 2026-08-14T18:48:37.409Z
updated: 2026-08-14T18:48:37.409Z
---

# Plan: CodeQL — "Replacement of a substring with itself"

## Summary

CodeQL flags `drone-agent/test/git-name-status.test.ts:40` — `.replace(/\t/g, '\t')` replaces a tab with a tab, a no-op. It's pointless dead code in a test. The fix is to remove the `.replace(...)` call.

## Details

Line 40 (in the "handles a mixed rename + modified batch" test):

```ts
'M\ta.ts\nR100\tb.ts\tc.ts\nA\td.ts\n'.replace(/\t/g, '\t');
```

The `.replace(/\t/g, '\t')` is a no-op (tab → tab). The string literal already contains literal tabs. Removing it leaves the same input string and the same expected output.

## Steps

1. `drone-agent/test/git-name-status.test.ts` line 40 — remove `.replace(/\t/g, '\t')`:
   ```ts
   const out = nameStatusToItems('M\ta.ts\nR100\tb.ts\tc.ts\nA\td.ts\n');
   ```
2. No behavior change (the replace was a no-op). The existing test still passes unchanged.
3. Validation: LSP zero errors; `pnpm -r run lint` zero errors; `pnpm -r run build` zero errors; fast test suite passes (specifically `git-name-status.test.ts`).

## Files touched

- drone-agent/test/git-name-status.test.ts

## Notes

- No drone-core changes → no cross-package rebuild needed before typecheck, but run `pnpm -r run build` as part of validation anyway.

---
key: plan-self-improvement-trim-before-validate
tags:
  []
created: 2026-08-25T18:10:06.333Z
updated: 2026-08-25T18:10:06.333Z
---

# Plan: Fix opaque TypeError crashes in self-improvement tools (trim-before-validate)

## Summary

The `self-improvement` plugin's tools blindly cast-and-trim LLM-supplied input fields (`(input.x as string).trim()`) BEFORE `validateTarget()` runs its friendly null-guard. Since `plugin-engine.ts` `executeTool()` dispatches straight to `tool.execute()` with NO JSON-schema validation layer, an omitted `targetId` (schema only requires `['action']`) crashes with `TypeError: Cannot read properties of undefined (reading 'trim')` instead of the intended `"targetId must be a non-empty string."` error. Existing tests missed this because they only tested `targetId: ''` (empty string survives `.trim()`) — never *omitted* `targetId`.

Scope confirmed with user: plugin-wide fix ONLY (`insight`, `principle`, `mark_examined` tools). Cross-plugin sweep (`memory/index.ts:166`, `bootstrap/index.ts:81` flagged by regex) is deferred to a follow-up plan.

## Failure sites

| # | File | Line | Expression | Trigger |
|---|------|------|-----------|---------|
| 1 | src/plugins/self-improvement/tools/insight.ts | ~84 | `(input.targetId as string).trim().toLowerCase()` | record/recall without targetId (THE reported bug) |
| 2 | src/plugins/self-improvement/tools/insight.ts | ~87 | `(input.insight as string).trim()` | record without insight |
| 3 | src/plugins/self-improvement/tools/principle.ts | ~91 | `(input.targetId as string).trim().toLowerCase()` | store/recall/delete without targetId |
| 4 | src/plugins/self-improvement/tools/principle.ts | ~94 | `(input.principle as string).trim()` | store without principle |
| 5 | src/plugins/self-improvement/tools/mark-examined.ts | ~39 | `(input.targetId as string).trim().toLowerCase()` | defense-in-depth only (schema requires both fields, but nothing enforces that) |

Do NOT touch `(input.source as string | undefined)?.trim() || undefined` in principle.ts (~line 96) — already null-safe via optional chaining.

## Design decisions (user-approved)

1. Shared helpers in `src/plugins/self-improvement/validation.ts`; all five sites funnel through them; existing `if (!targetId)` guard in `validateTarget` catches both `''` and omitted identically.
2. Error messages stay byte-identical (`targetId must be a non-empty string.`, `principle must be a non-empty string.`, `insight must be a non-empty string.`) — asserted by existing tests; proves backward compat for the empty-string path.
3. Regression tests added inside existing test files, mirroring the existing empty-string cases.
4. REJECTED: tightening JSON schemas with `if/then` conditional requirements — provider support inconsistent across LLMs; the runtime guard is the real safety net.

## Implementation steps

### Step 1 — coder: add normalization helpers to validation.ts
In `drone-agent/src/plugins/self-improvement/validation.ts` add:

```ts
/**
 * Trim a possibly-missing string input. Returns '' for non-strings so
 * downstream non-empty guards produce friendly errors instead of TypeErrors.
 */
export function trimOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
```

(One helper covers both targetId and text fields; callers append `.toLowerCase()` themselves where the old code did.)

### Step 2 — coder: fix insight.ts
- `const targetId = (input.targetId as string).trim().toLowerCase();` → `const targetId = trimOrEmpty(input.targetId).toLowerCase();` (add `trimOrEmpty` to the existing import from `'../validation.js'`)
- Same for `const insight = trimOrEmpty(input.insight);`

### Step 3 — coder: fix principle.ts (depends on step 1)
Same transformation at both sites (lines ~91, ~94).

### Step 4 — coder: fix mark-examined.ts (depends on step 1)
Same transformation at line ~39.

### Step 5 — tester: regression tests, insight.test.ts
In `drone-agent/test/self-improvement/insight.test.ts`, next to the existing "rejects empty targetId" / "rejects empty insight" cases (~line 288+), add three cases calling `engine.executeTool('self-improvement__insight', ...)` with the field OMITTED entirely:
- `{ action: 'record', targetType: 'persona', insight: 'Some insight.' }` → `.rejects.toThrow(/targetId must be a non-empty string/)`
- `{ action: 'recall', targetType: 'persona' }` → same assertion
- `{ action: 'record', targetType: 'persona', targetId: 'foo' }` → `.rejects.toThrow(/insight must be a non-empty string/)`

These reproduce the exact reported crash pre-fix (executeTool has no schema enforcement, so the test hits the same unprotected path as production).

### Step 6 — tester: regression tests, principles.test.ts
In `drone-agent/test/self-improvement/principles.test.ts` (836 lines), locate the existing rejects-cases via grep for `must be a non-empty string` and add omitted-field mirrors:
- store without `targetId` → `/targetId must be a non-empty string/`
- store without `principle` → `/principle must be a non-empty string/`
- delete without `targetId` → `/targetId must be a non-empty string/`

### Step 7 — tester: regression test, mark-examined.test.ts
In `drone-agent/test/self-improvement/mark-examined.test.ts` add:
- `engine.executeTool('self-improvement__mark_examined', { targetType: 'persona' })` → `.rejects.toThrow(/targetId must be a non-empty string/)`

### Step 8 — reviewer: check against validation criteria below

Execution order: 1 → (2, 3, 4 in parallel or sequence) → (5, 6, 7 in parallel) → 8.

## Validation criteria

1. Targeted: `pnpm vitest run test/self-improvement` — all green including new cases (verify they FAIL on un-fixed source if run before steps 2–4).
2. LSP diagnostics: zero errors/warnings across the workspace (`lsp__get_diagnostics`).
3. `pnpm -r run build` passes with zero errors.
4. `pnpm lint` (root) passes — eslint + prettier; re-read files after prettier reformats.
5. Full fast suite `pnpm test` passes.
6. Grep confirms zero remaining `(input.<field> as string).trim(` occurrences under `src/plugins/self-improvement/`.
7. Error messages unchanged: existing tests asserting exact messages still pass untouched.
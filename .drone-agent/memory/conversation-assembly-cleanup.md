---
key: conversation-assembly-cleanup
tags: []
created: 2026-09-11T22:49:25.526Z
updated: 2026-09-11T22:49:25.526Z
---

# Plan: Cleanup typecheck + failing test after conversation-assembly unification

## Summary

The copilot session unified conversation assembly: `DronePluginEngine.buildSystemMessages`/`buildFooterMessages`
are now OPTIONAL host-provided overrides only (the engine's fallback implementations were deleted).
Single canonical owner of assembly = `ContextBudgetService`. The host (`src/index.tsx`) wires
`budgetService.buildSystemMessages/buildFooterMessages` into the engine. The footer is wrapped in
explicit `<system-reminder>` tags — FINAL, keep as-is.

## Why

The type-change (required → optional) left one stale caller that typechecks as an error and
fails at runtime. Cleanup so the unified changes are green.

## Files / blast radius (verified by test run)

- `drone-agent/test/plugin-engine.test.ts` — 42/42 PASS (already updated by copilot session; buildFooterMessages?.() → undefined)
- `drone-agent/test/context-budget-service.test.ts` — 10/10 PASS
- `drone-agent/test/skills-plugin.test.ts` — 1 FAILED / 8 pass
  - FAIL: "never renders remark in the LLM-facing skills prompt fragment" at line 342
  - TypeError: engine.buildSystemMessages is not a function (LSP: 'engine.buildSystemMessages' is possibly 'undefined' 2722/18048)

## Step-by-step implementation

### Step 1 — Fix skills-plugin.test.ts (the failing test + typecheck error)

File: `drone-agent/test/skills-plugin.test.ts` (line ~334-345)
Replace the call to the now-optional `engine.buildSystemMessages()` with the engine's
non-optional `renderPromptFragmentsByPhase('header')` surface:

- The skills fragment is registered as `phase: 'header'` (src/plugins/skills/index.ts:62).
- `renderPromptFragmentsByPhase('header')` returns `string[]` (rendered, false/empty filtered).
- Change:
  ```ts
  const messages = await engine.buildSystemMessages();
  const systemText = messages.map(m => m.content).join('\n');
  ```
  to:
  ```ts
  const fragments = await engine.renderPromptFragmentsByPhase('header');
  const systemText = fragments.join('\n');
  ```
- Keep the three assertions unchanged (`toContain('# Skills')`, `toContain('remarked')`, `not.toContain(REMARK)`).

### Step 2 — Remove stale/duplicate JSDoc in plugin-engine.ts

File: `drone-agent/src/runtime/plugin-engine.ts` (lines ~144-147)
There are two consecutive JSDoc lines on `buildSystemMessages`:

- Line 146 (stale): "Build header system messages (config prompt + runtime flags + header prompt fragments)."
- Line 147 (correct): "Build header system messages from the host-provided override, if any."
  Remove line 146 only; keep the correct one. Line 148 stays as-is.

### Step 3 — Verify (no functional changes expected)

Run from repo root `/home/unleet/Projects/drone-agent`:

- `pnpm -r run typecheck` — must pass with zero errors
- `pnpm -r run lint` — must pass (eslint + prettier; note: prettier may reformat touched files)
- `pnpm -r run build` — must pass
- `pnpm -r run test` (fast suite) — all suites pass, incl. the three above
- Targeted confirmation: `pnpm vitest run drone-agent/test/skills-plugin.test.ts drone-agent/test/plugin-engine.test.ts drone-agent/test/context-budget-service.test.ts`

## Validation criteria (final step)

1. LSP clean on all touched files (`skills-plugin.test.ts`, `plugin-engine.ts`, plus the 4 already-modified files).
2. `pnpm -r run typecheck` passes with zero errors.
3. `pnpm -r run lint` passes.
4. `pnpm -r run build` passes.
5. Fast test suite passes; specifically skills-plugin 9/9, plugin-engine 42/42, context-budget-service 10/10.
6. No functional/behavioral change — the `<system-reminder>` footer wrap and the optional-override architecture are preserved exactly.
7. The remaining uncommitted changes (context-budget-service.ts, plugin-engine.ts, context-budget-service.test.ts, plugin-engine.test.ts) are committed together with the two cleanup edits on the current branch.

## Notes / gotchas

- All files are on branch `feat/slash-commands-during-working-fix` with 4 uncommitted files from the copilot session — plan assumes committing on this branch is intended (per AGENTS.md, on a feature branch always check in memories/plans/insights with the changes).
- Do NOT modify the `<system-reminder>` footer wrap — behavior is final.
- Run vitest from repo root (root vitest.config.ts uses repo-root-relative includes); `cd drone-agent && pnpm vitest run test/...` finds no files.

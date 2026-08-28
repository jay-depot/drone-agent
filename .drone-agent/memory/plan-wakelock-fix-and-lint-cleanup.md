---
key: plan-wakelock-fix-and-lint-cleanup
tags: []
created: 2026-08-28T15:59:37.979Z
updated: 2026-08-28T16:03:49.152Z
---

# Plan: Wakelock debug-flag fix + lint cleanup (+ // NEW: comment cleanup)

## Summary

Two workstreams on branch `feat/wake-lock-plugin`:

1. Fix a real runtime bug: the wakelock plugin's `--debug wakelock` path calls `runtime.flags.isEnabled(...)` but the injected `_runtime.flags` is a `RuntimeFlagRegistry` (has/get/set/append/entries/render — NO isEnabled). The plugin actually wants the separate `DebugFlagRegistry` (isEnabled/enable/disable/list) that the engine already receives at construction (plugin-engine.ts:313) but does NOT expose to plugins. Result: every acquire/release throws a swallowed TypeError; `--debug wakelock` can never work; the test mock fabricates `flags.isEnabled`, hiding the violation.
2. Clean up all 228 eslint errors after re-enabling linting to ignore only node_modules+dist. Approach C: real types where feasible, `unknown` where a precise shape can't be expressed. ZERO `any` and ZERO `eslint-disable` comments remaining.
3. Remove stray `// NEW:` scaffold comments (5 across cli.ts x3, plugins/index.ts x1, plugin-engine.ts x1).

## SCOPE LIMIT (user-locked 2026-08-28)

This refactoring is limited to: A (wakelock fix) + B (228 lint errors) + C (// NEW: comments). NO other refactors. Explicitly OUT of scope for this effort (do not do unless separately requested):

- Splitting the 4 oversized files (lsp/server.ts 1659, mcp/client.ts 1603, conversation-service.ts 1202, plugin-engine.ts 1036)
- drone-gateway/src/cleanup.ts unreachable code after process.exit
- Deprecated React FormEvent in coordinator-ui
- AGENTS.md package-count wording (already resolved by user separately)

## Note

- If you run into any blocking issue that substantially increases scope while working on this plan, pause and seek clarification before proceeding.

## Scope (eslint, 82 files, 228 errors)

- 125 @typescript-eslint/no-explicit-any (33 prod / 92 test)
- 65 @typescript-eslint/no-unused-vars
- 15 @typescript-eslint/no-unsafe-function-type (memory-index.test.ts ~12, notepad.test.ts ~3)
- 12 no-useless-assignment (lsp/server.ts x4, openai-driver x3, anthropic-driver, log/index.ts, config/index.ts, normalize/helpers.ts, persona/loader.ts)
- 5 preserve-caught-error (lsp/installer.ts x2, search/index.ts x2, conversation-service.ts x1)
- 4 no-control-regex (memory/store.ts \x00-\x1f, useSgrMouse.ts + syntax-highlight.ts + tui-persona-color.test.tsx \x1b)
- 2 prefer-const

## Workstream A — Wakelock fix

A1. plugin-engine.ts:791-799: add `debugFlags` to the `_runtime` capability object (the DebugFlagRegistry already in scope at line 313).
A2. wakelock/index.ts: replace local `RuntimeInfo.flags:{isEnabled}` with `runtime.debugFlags.isEnabled('wakelock')`; reference the real exported `DebugFlagRegistry` type from drone-core instead of fabricating a local RuntimeInfo interface.
A3. test/wakelock-plugin.test.ts: update mock `request('runtime')` to mirror real shape (debugFlags: {isEnabled}, keep isSubagent). Add a regression test asserting acquire/release logging fires through a REAL engine wiring (debug flag on), proving the TypeError is gone.
A4. Sweep other \_runtime consumers: subagent/plugin.ts:43 (own RuntimeInfo {subagentId,persona,isSubagent}), persona/index.ts:342 (request<{persona?:string}>).

## Workstream B — Lint cleanup

B1. Production `any` with real types available:

- Markdown.tsx (10 sites): marked.lexer() tokens — marked ships own types (node_modules/marked/lib/marked.d.ts). Use real marked token types.
- swarm/hooks.ts (7): insights/principles JSON API responses — define local interfaces.
- coordinator-client.ts (9): session shapes (getSessions/getSessionLog/processSession/completeSessionProcessing returning any) — check drone-core existing types first; define local interfaces where none exist.
- compaction/index.ts:398 + ollama/driver.ts:420: `(error as any)?.status_code` — prefer typed narrowing; ollama errors are DroneLlmError.
- self-improvement/validation.ts:83: `(skill as any)?.scope` — real Skill type.
- swarm/providers.ts:64.
  B2. Test `any` (92 sites): type the mocks with real types / `unknown`; zero `any` and zero `eslint-disable` even in tests.
  B3. no-unsafe-function-type: memory-index.test.ts + notepad.test.ts — replace `Function` with concrete signatures.
  B4. preserve-caught-error (5): attach `{ cause: error }`.
  B5. no-useless-assignment (12): remove dead assignments.
  B6. no-control-regex (4): proper regex escapes (\u001b, char-class escapes).
  B7. no-unused-vars (65): delete unused imports/vars, or `_`-prefix intentional destructures.
  B8. prefer-const (2):
- mcp-client.test.ts:890 `captured` — safe let→const.
- index.tsx:171 `resetStuckDetectorsRef` — DANGER: eslint flags it but it IS reassigned at index.tsx:316. VERIFY first (stale eslint cache vs real shadowing); blind let→const BREAKS build. Goal is zero eslint-disable, so find root cause.

## Workstream C — // NEW: comment cleanup (user-approved, in scope)

- cli.ts:9 `// NEW:` above subagentId/persona/workflow fields → remove
- cli.ts:144 `// NEW: subagent mode flags` → remove
- cli.ts:234 `// NEW: env var fallback for subagent mode flags` → remove
- plugins/index.ts:36 `// NEW:` above import run → remove
- plugin-engine.ts:188 `// NEW:` above runtimeOptions → remove
  These files are already in the B edit set, so this is zero extra effort.

## Order / dependencies

1. Workstream A first (small, self-contained, fixes real bug, exercises shared \_runtime shape change).
2. Workstream B: prod any (B1) → test any (B2) → mechanical (B3-B8). Mechanical rules independent, parallelizable. Fold in C when touching cli.ts/plugins/index.ts/plugin-engine.ts.
3. `pnpm build` after touching drone-core types (plugin-engine + runtime resolve drone-core from dist).

## Validation criteria

- `npx eslint . --ext .ts,.tsx` → 0 errors, 0 warnings; grep confirms no `eslint-disable` comments and no `: any` / `as any` / `<any>` remaining in src/ and test/.
- `pnpm -r run typecheck` and `pnpm -r run build` pass (drone-core rebuilt first).
- `pnpm lint` (eslint + prettier) passes; note prettier reformats — re-read files after running it.
- `pnpm test` passes (2324 currently green; wakelock regression test added and green).
- LSP diagnostics clean for every file touched.
- No new `any`, no new `eslint-disable`, no scope creep beyond A/B/C.

## Notes / traps

- User already edited: let→const in app-commit-flow.test.tsx, persona-wizard.test.ts, swarm.ts (verify — app-commit-flow `unregister` may be reassigned!); stripped eslint-disable in syntax-highlight.ts leaving blank lines at ~231, ~268 that still need real types.
- app-commit-flow.test.tsx: user changed `let unregister` → `const unregister`; check if unregister is later reassigned (would break build) — verify before assuming the user's edit is safe.

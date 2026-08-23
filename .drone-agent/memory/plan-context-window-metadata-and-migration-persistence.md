---
key: plan-context-window-metadata-and-migration-persistence
tags:
  - plan
  - bugfix
  - llm
  - providers
  - migration
  - context-window
  - executed
created: 2026-08-23T18:23:17.849Z
updated: 2026-08-23T18:51:00.145Z
---

# Plan: Context-window resolution via broker metadata + durable legacy-config migration

## Summary

Two coupled defects on branch `feat/provider-model-config`:

1. **Context usage misreported (~50%+ on 1M models at fresh start).** Phase 2's driver conversion dropped `getContextWindowInfo` from the openai/anthropic/openrouter protocol plugins (method is optional; TS silent). `ContextBudgetService.resolveContextWindow()` fell back to `session.contextWindowTokens` (default **32768**), collapsing the denominator. Same bogus window fed `requiresSafetyTrim` and compaction.
2. **Legacy→providers migration never persisted.** `migrateLegacyProviderConfig()` ran every startup in memory only with a "please hand-edit" warning. `${VAR}` interpolation happens at parse time, so naive write-back would leak resolved secrets.

## Locked decisions
- Q1: `DroneContextWindowInfo.source` union extended with `'metadata'`
- Q2: Precedence: **declared → discovered → live driver probe → session fallback**
- Q3: Auto-persist on change; backup `config.json.<timestamp>.old`; file-backed scopes only; project scope = memory + redirect warning (providers banned there); swarm underlays memory-only
- Q4/Q7: Legacy sections stripped unconditionally on any migration write (incl. shadowed sections in mixed-format files)
- Q5: Persisted content derived from raw re-parsed JSON — templates stay templates, literals stay literals
- Q6: Inline API keys relocated faithfully + advisory warning, never rewritten

## Execution status: COMPLETE (2026-08-23)

### Implemented
- **A1**: `drone-core/src/session-types.ts` — source union += `'metadata'`, provenance doc comment.
- **A2/B-gate**: `pnpm -r run build` after core change; stale-dist phantom diagnostics cleared as predicted.
- **B1/B2**: `drone-agent/src/plugins/llm/index.ts` — new `resolveActiveContextWindow(instance, requestedModel)` helper + `contextWindowProvenanceLogged` Set; capability's `getContextWindowInfo` now delegates to it instead of bind-through. Resolves declared⊕alias-base⊕discovered metadata first (`'metadata'`), falls back to inner provider probe (model normalized to full `<providerId>/<localId>` form), then session config (`'config'`). Logs provenance once per model per session.
- **B3**: `drone-agent/test/llm-context-window.test.ts` — 7 tests: declared-wins-no-probe, discovered-over-probe (via real listModels() discovery path), live probe fallback, alias-base, session fallback, model-switch freshness, provenance-once logging.
- **C1**: `provider-migration.ts` rewritten around one structural transform. New exports: `migrateLegacyProviderConfigRaw(input, {stripLegacy})` → `{raw, migratedSections, inlineKeySections, seededActive?, changed}` (pure, non-mutating), `listRawLegacySections`, `LEGACY_SECTIONS`. Decoded-config entry `migrateLegacyProviderConfig()` now delegates to the raw transform (behavior preserved — all 25 existing migration tests pass unmodified). `formatMigrationNotice(result, {backupPaths?})` reflects saved state.
- **C2**: NEW `runtime/provider-migration-persist.ts` — `persistLegacyProviderMigration(layers)`: for user/project layers whose RAW file contains ≥1 legacy section → copy to `config.json.<sanitized-ISO>.old` backup, apply raw migration with stripLegacy:true, seed llm.active only when file lacks it entirely, atomic write (tmp+rename). Project scope: no writes, redirect warning only. Inline keys → advisory warnings. Trigger is raw-file analysis (structural idempotence), not in-memory changed flag.
- **C3**: `runtime/config.ts` — persistence wired after in-memory migration; warnings merged ahead of scope/validation warnings; notice includes backup paths when written.
- **C4**: `test/provider-migration-persist.test.ts` — 7 tests covering template preservation + byte-exact backup, literal-key relocation + advisory, mixed-format strip, canonical no-op, project-scope redirect, second-run idempotence, tmp+rename shape.
- **D1**: `test/context-percent-regression.test.ts` — fresh-session <10% on declared 1M window; requiresSafetyTrim false; repro-of-bug >50% against stale 32768 default (documents the eliminated failure mode).
- **D2**: swept all `DroneContextWindowInfo` consumers and `.source ===` comparisons — zero breakage from union widening (only unrelated skill-source comparison exists).
- **E2**: `docs/agents/provider-model-config.md` — persistence semantics (backup naming, atomicity, template preservation, strip policy, project-scope behavior) + context-window resolution chain documented; AGENTS.md sentence updated to "migrated into providers and persisted to the file on first load".

### Validation results (E1)
- `pnpm -r run build`: exit 0 (one transient caught by build that LSP missed initially: `boolean | undefined` from optional-chained flag in ternary-less expression — fixed via `=== true`)
- Root `pnpm test`: **2151 passed / 9 skipped**, 0 failures
- Root `pnpm lint`: exit 0, prettier clean
- `pnpm typecheck` + fresh `tsc -p tsconfig.test.json --noEmit`: exit 0 (authoritative over stale LSP cache)
- Manual TUI smoke deferred to user (requires real env: would rewrite actual ~/.drone-agent/config.json + spend API tokens)

### Commits
- `42cc552` checkpoint before execution
- `4f12ac3` fix(llm): broker metadata context-window resolution + durable legacy migration persistence

### Notes for future work
- The persist module intentionally does NOT rewrite when only swarm underlays carry legacy data (no file to own the change).
- Provenance log line is the debugging anchor for any future "wrong denominator" reports: grep "Context window for".
- Migration module remains deletable post-window: delete provider-migration.ts, provider-migration-persist.ts, their tests, and the legacy-section mentions in docs/AGENTS.md together.
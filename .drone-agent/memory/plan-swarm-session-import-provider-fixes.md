---
key: plan-swarm-session-import-provider-fixes
tags:
  - plan
  - swarm
  - session-import
  - llm
  - providers
  - manual-testing
created: 2026-08-25T15:13:38.816Z
updated: 2026-08-25T15:55:06.188Z
---

# Plan: Repair feat/swarm-session-import after provider refactor (#70 merge)

## Summary

Merge 8f63c48 (main → feat/swarm-session-import, 2026-08-25) pulled in the provider/protocol/model refactor (8a56922, #70). Exactly one compile defect resulted: `drone-agent/test/session-command.test.ts` makeLlm() mock lacks the new required `registerDriver` member (TS2741; CI typecheck gate red; runtime suite fully green — vitest does not typecheck). User chose Option B scope: while touching the file, ALSO consolidate the swarm plugin's hand-rolled context-window resolver onto the canonical ContextBudgetService (backlog `llm-provider-future-work` item 6, partial: swarm copy only; compaction's heuristic copy explicitly deferred), via FUNNEL CONVERSION: swarm moves out of staticBuiltInPlugins into createBuiltInPlugins deps, receiving a narrowly-scoped injected resolver. Branch runtime LLM usage otherwise audited compatible post-refactor (bare local ids into chat(); broker-enriched getContextWindowInfo — verified by subagent report + matches compaction//context patterns).

MANUAL TESTING after deploy lives in separate reference memory `manual-test-swarm-session-import` (kept out of this plan so wiki ingest doesn't consume the runbook).

## Status — COMPLETE (executed 2026-08-25)

All implementation steps executed on feat/swarm-session-import. Commits: a301c7d (plan+runbook memory), 50e31d1 (steps 1–2: SwarmPluginDeps + optional getContextWindowTokens injection, resolver deleted), 10484f8 (steps 4–7: funnel conversion in plugins/index.ts, index.tsx wires budgetService.resolveContextWindow, test fixes).

### What was done

- swarm/index.ts: `SwarmPluginDeps { resolveContextWindow? }`; `createSwarmPlugin(config, deps?)`; singleton export deleted; command receives `async () => (await resolveContextWindow()).contextWindowTokens` when dep present, else undefined (const-captured for TS narrowing).
- session-command.ts: private `resolveContextWindowTokens` DELETED; `createSwarmSessionCommand(baseUrl, currentSessionId, config, getContextWindowTokens?)`; fallback helper `defaultGetContextWindowTokens` = `ctx.engine.getConfig?.()?.session.contextWindowTokens ?? 32768`.
- plugins/index.ts: swarm removed from staticBuiltInPlugins; created inside createBuiltInPlugins with deps typed `CompactionPluginDeps & { resolveContextWindow?: () => Promise<DroneContextWindowInfo> }`; builtInPlugins doc comment updated.
- index.tsx: deps gain `resolveContextWindow: () => budgetService.resolveContextWindow()` (shares service cache; conversation-service invalidates via resetContextWindowCache on model change).
- test/session-command.test.ts: makeLlm() adds required `registerDriver: () => {}` (THE CI fix); provider-level getContextWindowInfo mock removed; all import tests inject `getContextWindowTokens` vi.fn(1000) and assert call-through; NEW test asserts no-dep fallback budget floor(32768×12%)=3932.
- session-import.ts: unchanged (verified).
- Sweep: zero remaining workspace references to `swarmPlugin` identifier; lib.ts re-exports remain valid; drone-swarm-common verification harness has no dependency on the static array.

### Validation

- LSP: zero errors workspace-wide. Root `pnpm typecheck`: exit 0 (0 TS errors; previously failing gate). `pnpm lint`: exit 0. `pnpm -r run build`: exit 0. Fast suite: 157 files passed / 2250 tests passed / 9 skipped (was 2249; +1 new fallback test).
- Post-deploy manual verification pending user deploy: follow runbook memory `manual-test-swarm-session-import` (T0–T8).

### Session gotchas (also logged as insights)

- git__commit tool rejects multi-line commit messages (opaque failure); single-line works; amend via exec. A failed long-message attempt left its staged files staged and a subsequent placeholder commit swept them up — repaired by exec `git commit --amend`. Never parallel-call todo updates with commits.
- typescript-language-server served stale diagnostics matching pre-patch snapshots during rapid apply_diff sequences; file reads + root typecheck were ground truth.

## Locked decisions

- Funnel conversion (NOT optional-dep-with-inline-fallback). Inline resolver deleted, not demoted.
- Deps shape: narrow primitive threaded through createBuiltInPlugins deps (intersection extension, CompactionPluginDeps untouched).
- createSwarmPlugin(config, deps?) — deps optional; existing test constructions stay valid; config-only fallback matches graceful-degradation style.
- Token-budget MATH stays in the command; only RESOLUTION injected.
- Compaction's divergent resolver + fallback heuristic: OUT OF SCOPE (deferred backlog item 6 remainder).

## Out of scope / deferred

- Compaction resolver consolidation (backlog item 6 remainder). tools-coordinator direct-coordinator proxying (completed separately). Interactive session picker.

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
updated: 2026-08-25T15:25:36.595Z
---

# Plan: Repair feat/swarm-session-import after provider refactor (#70 merge)

## Summary
Merge 8f63c48 (main → feat/swarm-session-import, 2026-08-25) pulled in the provider/protocol/model refactor (8a56922, #70). Exactly one compile defect resulted: `drone-agent/test/session-command.test.ts` makeLlm() mock lacks the new required `registerDriver` member (TS2741; CI typecheck gate red; runtime suite fully green — vitest does not typecheck). User chose Option B scope: while touching the file, ALSO consolidate the swarm plugin's hand-rolled context-window resolver onto the canonical ContextBudgetService (backlog `llm-provider-future-work` item 6, partial: swarm copy only; compaction's heuristic copy explicitly deferred), via FUNNEL CONVERSION: swarm moves out of staticBuiltInPlugins into createBuiltInPlugins deps, receiving a narrowly-scoped injected resolver. Branch runtime LLM usage otherwise audited compatible post-refactor (bare local ids into chat(); broker-enriched getContextWindowInfo — verified by subagent report + matches compaction//context patterns).

MANUAL TESTING after deploy lives in separate reference memory `manual-test-swarm-session-import` (kept out of this plan so wiki ingest doesn't consume the runbook).

## Locked decisions
- Funnel conversion (NOT optional-dep-with-inline-fallback). Inline resolver deleted, not demoted.
- Deps shape: narrow primitive `resolveContextWindow?: () => Promise<DroneContextWindowInfo>` threaded through createBuiltInPlugins deps (type extended as intersection, CompactionPluginDeps itself untouched).
- createSwarmPlugin(config, deps?) — deps optional so the ~12 existing test constructions stay valid; command degrades to config-only fallback (session.contextWindowTokens ?? 32768) when dep absent, matching the command's existing graceful-degradation style.
- Token-budget MATH (percent × window) stays in the command; only RESOLUTION is injected. Inject as `getContextWindowTokens: () => Promise<number>` at the command layer.
- Compaction's divergent resolver + fallback heuristic: OUT OF SCOPE (deferred backlog).

## Implementation steps (all drone-agent pkg; NO drone-core changes)
1. `src/plugins/swarm/index.ts`: add `export type SwarmPluginDeps = { resolveContextWindow?: () => Promise<DroneContextWindowInfo> }`; change `createSwarmPlugin(config: SwarmConfig, deps?: SwarmPluginDeps)`; DELETE `export const swarmPlugin = createSwarmPlugin({})` (line ~212); pass a resolver closure into createSwarmSessionCommand.
2. `src/plugins/swarm/session-command.ts`: signature → `createSwarmSessionCommand(baseUrl, currentSessionId, config, getContextWindowTokens: () => Promise<number>)`; DELETE private `resolveContextWindowTokens` (~lines 38–50); fallback when dep undefined: `ctx.engine.getConfig?.()?.session.contextWindowTokens ?? 32768`.
3. `session-import.ts`: unchanged.
4. `src/plugins/index.ts`: remove `swarmPlugin` from staticBuiltInPlugins; `createBuiltInPlugins(compactionDeps: CompactionPluginDeps & { resolveContextWindow?: () => Promise<DroneContextWindowInfo> })`; returned array `[...staticBuiltInPlugins, createSwarmPlugin({}, { resolveContextWindow: compactionDeps.resolveContextWindow }), createCompactionPlugin(...), createLogPlugin(...)]`; drop `swarmPlugin` re-export, keep `createSwarmPlugin`.
5. `src/index.tsx` (~line 118 deps object): add `resolveContextWindow: () => budgetService.resolveContextWindow()` (shares the service's per-model cache; conversation-service invalidates via resetContextWindowCache on model change → import always sees current model's window, better than today's per-call probe).
6. Belt-and-suspenders sweep (project principle): LSP find_references + grep for `swarmPlugin`, `builtInPlugins`, `createSwarmPlugin` — check lib.ts, embedding harnesses, drone-swarm-common/test/verification.test.ts (uses built-ins; confirm it doesn't need swarm), update any consumer that expected swarm in the static array.
7. `test/session-command.test.ts`: add `registerDriver: () => {}` to makeLlm() (THE CI fix); import-success tests switch from provider.getContextWindowInfo mocking to injected `getContextWindowTokens: async () => 1000`; assert fallback path (no dep → config 32768-derived budget) once.

## Validation criteria
- LSP zero errors (incl. session-command.test.ts — currently the only TS2741 site).
- `pnpm typecheck` exit 0 at ROOT (root tsconfig.test.json covers tests — this is CI's first gate and the currently failing one).
- `pnpm lint` clean; `pnpm -r run build` passes; fast suite `pnpm test` green.
- Grep sweep shows no stale swarmPlugin/builtInPlugins consumers expecting swarm in the static array.
- Post-deploy manual verification per runbook memory `manual-test-swarm-session-import`.

## Out of scope / deferred
- Compaction resolver consolidation (backlog item 6 remainder). tools-coordinator direct-coordinator proxying (separate plan `plan-swarm-tools-coordinator-refactor`, completed). Interactive session picker.
---
tags: [decision, swarm, session-import, llm, providers, testing, refactor, adr]
related: [decisions/146-swarm-session-import.md, decisions/156-broker-context-windows-migration-persistence.md, decisions/196-context-window-fallback-fix.md, modules/drone-agent-plugins.md, modules/drone-agent.md, concepts/provider-model-selection.md, concepts/test-infrastructure.md]
---

# 214: Swarm session import — provider-refactor repair + context-window funnel conversion

**Status**: Implemented (2026-08-25) · **Branch**: `feat/swarm-session-import` (`50e31d1`, `10484f8`) · **Plan**: project-memory `plan-swarm-session-import-provider-fixes` — *deleted from project memory after ingest*

**Summary**: Merging the provider/protocol/model refactor (`8a56922`, PR #70) into `feat/swarm-session-import` produced exactly one compile defect — the swarm session command's `makeLlm()` test mock lacked the new required `registerDriver` member (TS2741), turning the CI typecheck gate red while the runtime suite stayed fully green (vitest does not typecheck). Fixing that one line was the whole *repair*. Because the file had to be touched anyway, the plan also consolidated the swarm plugin's hand-rolled context-window resolver onto the canonical `ContextBudgetService` via **funnel conversion**, deleting the duplicate resolver rather than demoting it.

## Context

The provider refactor made `registerDriver` a required member of the LLM capability type. `drone-agent/test/session-command.test.ts`'s `makeLlm()` factory built a partial mock and so failed to satisfy the interface — a **typecheck-only** failure. The runtime test suite passed, because vitest transpiles without type checking. CI caught it; a local `pnpm test` would not have.

A separate pre-existing issue: the swarm plugin carried its own context-window resolver, duplicating logic that `ContextBudgetService` already owned. This was backlog item 6 of `llm-provider-future-work` (a `plan`-adjacent future-work memory), partially addressed here — the swarm copy only; compaction's divergent heuristic copy was explicitly deferred.

## Decision

1. **Repair scope (Option B, user-chosen)**: fix the `registerDriver` mock, and while in the file, also consolidate the swarm resolver onto the canonical service.
2. **Funnel conversion, not optional-dep-with-inline-fallback.** The inline resolver is **deleted**, not demoted to a fallback. A narrow primitive is threaded through `createBuiltInPlugins` deps.
3. **Token-budget math stays in the command; only resolution is injected.** The command keeps its budget arithmetic and asks for a context-window number.
4. **Compaction's divergent resolver is out of scope** (the remainder of backlog item 6).

## Implementation

- `drone-agent/src/plugins/swarm/index.ts` — new `SwarmPluginDeps { resolveContextWindow? }`; `createSwarmPlugin(config, deps?)`; the singleton export was deleted. The command receives `async () => (await resolveContextWindow()).contextWindowTokens` when the dep is present, else `undefined` (const-captured for TypeScript narrowing).
- `drone-agent/src/plugins/swarm/session-command.ts` — the private `resolveContextWindowTokens` was **DELETED**; `createSwarmSessionCommand(baseUrl, currentSessionId, config, getContextWindowTokens?)`; a fallback helper `defaultGetContextWindowTokens` reads `ctx.engine.getConfig?.()?.session.contextWindowTokens ?? 32768`.
- `drone-agent/src/plugins/index.ts` — swarm moved out of `staticBuiltInPlugins` into `createBuiltInPlugins`, where it is constructed with deps typed `CompactionPluginDeps & { resolveContextWindow?: () => Promise<DroneContextWindowInfo> }`.
- `drone-agent/src/index.tsx` — deps gain `resolveContextWindow: () => budgetService.resolveContextWindow()` (shares the service cache; the conversation service invalidates it via `resetContextWindowCache` on a model change).
- `drone-agent/test/session-command.test.ts` — `makeLlm()` gains the required `registerDriver: () => {}` (**the CI fix**); the provider-level `getContextWindowInfo` mock was removed; all import tests inject `getContextWindowTokens` (a `vi.fn(1000)`) and assert call-through; a NEW test asserts the no-dep fallback budget `floor(32768 × 12%) = 3932`.
- `drone-agent/src/plugins/swarm/session-import.ts` — unchanged (verified).

A sweep confirmed zero remaining workspace references to the `swarmPlugin` singleton identifier, `lib.ts` re-exports remain valid, and the `drone-swarm-common` verification harness has no dependency on the static array.

## Consequences

- The CI typecheck gate is green again, and the mock now matches the real interface — a future added member will fail **locally** in typecheck rather than only in CI, since the mock is type-complete.
- The swarm plugin no longer duplicates context-window resolution; it consumes the same cached `ContextBudgetService` value as compaction and the conversation service, so all three agree on the window and a model change invalidates one cache.
- Because deps are optional, config-only fallback preserves graceful degradation for existing test constructions.
- The duplicate-resolution class of bug remains open for **compaction** (deferred).

## Session gotchas (also logged as insights)

- **`git__commit` rejects multi-line commit messages** (opaque failure); single-line works, and amending requires `exec`. A failed long-message attempt left its files staged, and a subsequent placeholder commit swept them up — repaired with `git commit --amend`. Also: never parallel-call todo updates with commits.
- **`typescript-language-server` served stale diagnostics** matching pre-patch snapshots during rapid `apply_diff` sequences. File reads plus a root `pnpm typecheck` were ground truth.

## Validation

LSP zero errors workspace-wide. Root `pnpm typecheck` exit 0 (0 TS errors; the previously failing gate). `pnpm lint` exit 0. `pnpm -r run build` exit 0. Fast suite 157 files / 2250 tests passed / 9 skipped (up from 2249 — the +1 is the new fallback test).

**Pending (handed to the user)**: post-deploy manual verification via the separate runbook memory `manual-test-swarm-session-import` (T0–T8).

> **Note**: the runbook memory `manual-test-swarm-session-import` was deliberately kept **out of this plan** so that wiki ingest would not consume it; it remains in project memory as a reference. Its parent plan is now deleted, so the runbook is an intentional orphan rather than a dangling reference.

## Related

- [[decisions/146-swarm-session-import]] — the feature this repairs after the provider refactor
- [[decisions/156-broker-context-windows-migration-persistence]] · [[decisions/196-context-window-fallback-fix]] — the context-window resolution chain the funnel conversion routes through
- [[concepts/provider-model-selection]] — provider/model identity and the metadata resolution chain
- [[concepts/test-infrastructure]] — why a runtime-green suite can still fail the typecheck gate

---
key: plan-workflow-system-improvements
tags:
  - plan
  - executed
  - drone-core
  - drone-agent
  - workflows
  - tui
  - engine
  - swarm-memory
created: 2026-09-01T21:40:20.440Z
updated: 2026-09-01T22:16:29.495Z
---

# Plan: Workflow system improvements — TUI host, agent-assist primitive, session continuation, kick contract

## Status: EXECUTED (2026-09-01, feat/workflow-system-improvements)

All steps S1–S8 complete. Branch feat/workflow-system-improvements from feat/web-port-auth-enforcement@b00df23. Commits:
- 100529b (S1-S3): drone-core ctx.agent + continueSession types; runtime/ephemeral-conversation.ts (workflow-scoped in-memory session manager + conversation service on the engine's LLM broker/fragments/flags); plugin-engine runWorkflow binds lazy per-run ctx.agent, normalizes continueSession, wraps every kickMessage in the envelope (runtime/kick-envelope.ts); double-append removed at persona/skills /create; 4 engine tests
- 0810eff (S4): App initialWorkflow + onWorkflowComplete (run on mount, inline elicitations, kick reply as chat turn, continueSession honored, failures reported); index.tsx routes --workflow → TUI by default, --output-plain keeps readline + gains runInteractiveLoop continuation; 4 TUI tests
- 864f115 (S5): swarm-memory — detectServiceLaunch via ctx.agent (observes REAL unit/container names; restart-name mismatch fixed), summarize() kickMessage rewritten instruction-first + continueSession: true; coordinator --help HTTPS corrected; swarm-memory + wizard test harnesses updated (agent mocks)
- 0b3b4f0 (S8 fixes): plugin-engine-workflow.test.ts envelope assertions; tui.test.tsx pre-S4 suites RESTORED (a python truncation during test writing had deleted 12 tests — caught by lint unused-imports + test-count drop, root-caused via git show); prettier
- Vault beca18c (S6): ADR 183 + index count 183 + concept/workflow-system rewrite + tui/plugins module rows; AGENTS.md workflow section gained ctx.agent + continueSession + kick contract
- Insights: persona (idempotent-append synthetic turns), project x3 (host-selection sharing, captureEngine contextual-typing pattern, envelope assertion shift)

## Validation (all green)
- pnpm -r run build ✅; pnpm typecheck 0 errors ✅; pnpm lint ✅
- Root pnpm test: 2675 passed / 14 skipped (2689 total; +25 vs 2650 baseline) ✅
- Editor LSP lagged (stale cache showed fixed errors); pnpm typecheck is authoritative ✅
- Manual TUI smoke (--workflow bootstrap__swarm-memory live) left to operator; component-level behavior covered by 8 new tests

## Key execution learnings
- Engine self-reference: `return captureEngine({...literal})` pattern (typed wrapper fn) — annotating the literal `const engineObject: DronePluginEngine = {...}` kills contextual typing (15 implicit-any errors)
- ink-testing-library: programmatic exit() clears frames — assert on spies/captured state, not frames, on exit paths
- Overwriting an existing test file's describe blocks via python s.index() slicing silently deleted suites — lint's unused-import check + test-count delta caught it; always diff test-file changes against HEAD before committing
- makeOptions-style TUI test helpers: opts.engine.runWorkflow must be overridden on the ENGINE object (opts.runWorkflow at top level is silently ignored — no error)

## Deferred (unchanged)
Forward-context opt-in for ctx.agent; per-step tool allowlists; workflow model-role (ADR 164); CLI --stay override; phase-2 backlog (swarm.memory read-side bootstrap, stale-session review, librarian migration).
---
key: plan-workflow-system-improvements
tags:
  - plan
  - ready
  - drone-core
  - drone-agent
  - workflows
  - tui
  - engine
  - swarm-memory
created: 2026-09-01T21:40:20.440Z
updated: 2026-09-01T21:40:20.440Z
---

# Plan: Workflow system improvements — TUI host, agent-assist primitive, session continuation, kick contract

## Summary

Four user-reported defects/design gaps in the workflow system: (1) `--workflow` always runs in plain-output mode because the workflow branch executes before the TUI mounts (index.tsx:429-443); (2) workflows have no way to use the LLM as a step in their flow (only human elicitation exists); (3) workflows exit immediately on completion — no continuation for followups, and nothing declares whether continuation makes sense; (4) the kickMessage handoff is broken: the message is appended to the session TWICE (engine double-append: index.tsx:450 + conversation-service.ts:452 sendUserMessage appends its own prompt; same bug at persona/index.ts:583 and skills/index.ts:341), arrives unframed (model can't tell instruction from report — swarm-memory's kickMessage is a status report), and no contract says what kickMessage is for.

## Grilled decisions (2026-09-01)

- Q1 TUI default host: `--workflow` without `--output-plain` mounts the full TUI with `initialWorkflow {name, args}` prop; workflow runs on mount inside App (TUI owns elicitation wiring), elicitations render via ElicitationPrompt, tool activity streams via existing event subscription; kick-reply is a normal chat turn. `--output-plain` keeps readline behavior; `--output-json` untouched.
- Q2 ctx.agent(): new member on DroneWorkflowContext — `(prompt: string, opts?: { label?: string }) => Promise<string>` returning the final assistant reply. One synthetic turn through the conversation machinery's normal tool loop (guardrails + engine conversation events fire → TUI renders). Workflow-scoped EPHEMERAL conversation: agent steps within one run see each other, nothing lands in main session history (forward-context opt-in deferred until something calls for it). Full registered tools (no allowlists in v1 — workflow authors are trusted code). Active provider/model. Subagent processes and elicitation-overloading rejected.
- Q3 continueSession: workflow-owned `continueSession?: boolean` on DroneWorkflowResult. TUI: false/absent → exit after kick-reply (programmatic exit after reply renders); true → session stays live with full context. Plain mode: true → drop into runInteractiveLoop instead of exiting. JSON: no-op. No CLI override in v1. toolResult NOT injected into LLM context on continuation (handoff = kickMessage alone).
- Q4 kick contract: (a) engine envelope — runner wraps kickMessage in a standard frame: `Workflow <name> completed and handed off the following. Read it and continue the session appropriately:\n\n---\n<kickMessage>\n---` (retroactive fix for all workflows). (b) documented contract: kickMessage = instruction to the agent, not a report to the user; reports belong in toolResult. Engine removes the double-append at all three sites.
- Fold-in (approved): restart unit-name fix (use observed unit/container name — resolution now via agent observation, see S5) and coordinator --help HTTPS-default drift line, since S5/S6 rewrite those files anyway.

## Steps (branch: feat/workflow-system-improvements; execute AFTER plan-web-port-auth-enforcement — S3/S5 here touch the same swarm-memory files; deps: S1→S2→S3→S4, S5 after S4, S6 after S5, S7/S8 last)

- S1 (coder, drone-core): src/plugin-system.ts — add `continueSession?: boolean` to DroneWorkflowResult (~~:231; survives the RunReturn union normalization at :242); add `agent` to DroneWorkflowContext (~~:205) with JSDoc contract (ephemeral workflow-scoped history, full tools, active model, reply-only return). Types already re-exported via src/index.ts:262-264. Then `pnpm -r run build` BEFORE touching dependents (they resolve drone-core from dist/).
- S2 (coder, runtime): ephemeral conversation factory. Inspect createConversationService({engine, sessionManager, ...}) (runtime/conversation-service.ts:150, called index.tsx:204). Add a per-run lazy factory (e.g. in plugin-engine or a new runtime helper): fresh in-memory session manager + conversation service sharing the engine's LLM capability and hooks. Lifetime = one workflow run; discard after. No persistence, no main-session writes.
- S3 (coder, engine): plugin-engine runWorkflow — build ctx with `agent` bound to the ephemeral conversation (`sendUserMessage(prompt, undefined)` → return final reply text); normalize `continueSession` through the result normalizer (plugin-engine.ts:1029-1040). Add `buildKickEnvelope(workflowName, kickMessage)` runtime helper; use it at all three kick sites AND delete the redundant pre-append lines: index.tsx:450, persona/index.ts:583, skills/index.ts:341. Tests: engine test for envelope shape + continueSession normalization; fix any wizard tests asserting the old double-append behavior.
- S4 (coder, TUI host): index.tsx workflow branch — route to TUI by default; App gains `initialWorkflow` + `onWorkflowComplete(continueSession)` props; App runs workflow on mount, renders kick-reply as a chat turn (envelope already applied by runner or applied here — one site only), then stays (true) or calls back to unmount (false). Plain mode: after kick-reply, `continueSession ? runInteractiveLoop(...) : exit`. Keep branch thin; put decision logic in a testable helper. Tests: ink-testing-library with mock engine (poll-based waits per project principle — NO fixed ticks), covering: workflow runs on mount, elicitation renders, continuation honors the flag.
- S5 (coder, swarm-memory rewrite + nits): bootstrap/swarm-memory.ts — (1) `continueSession: true` in summarize() return. (2) Replace detectLaunchMode's hardcoded probes with a ctx.agent discovery step ("Determine how the drone-coordinator service runs on this host — systemd unit (check the actual unit name), docker container (actual container name), or bare process — and report the exact restart command"), keep the confirm gate + verify-by-reprobe; this OBSERVES the real unit/container name, fixing the restart-name mismatch organically (fold-in #1). (3) Rewrite summarize() kickMessage to the contract: instruction-first ("You just completed bootstrap__swarm-memory. Report to the user: …; if pendingRestart is non-empty, list the exact restart commands…; suggest phase-2 followups: swarm.memory read-side opt-in, stale-session review, librarian migration"), keep toolResult JSON as the detailed report. (4) Coordinator --help HTTPS line: drone-coordinator/src/index.ts ~:158 `--https` help text → states hardcoded default true (fold-in #2). Tests: swarm-memory.test.ts — mock ctx.agent (add to the workflow-test harness), agent-driven launch detection test, kickMessage content assertions, help-text test if one exists.
- S6 (docs): ADR 183 in /home/unleet/Obsidian/drone-agent-project/decisions/183-workflow-system-improvements.md; vault updates: decisions/index.md (+1, both tables), concepts/workflow-system.md (full contract rewrite: TUI host, ctx.agent, continueSession, kick envelope + instruction-not-report rule), modules/drone-agent-tui.md (initialWorkflow), modules/drone-agent-plugins.md + modules/drone-beacon-adjacent bootstrap rows. Repo docs: AGENTS.md workflow section gains ctx.agent + continueSession.
- S7 (insights/memory): log insights (planner persona: "runners that shell out must surface stderr" already logged-class — new: "synthetic turns must be idempotent-append: audit both the caller and sendUserMessage for double-writes"; "output-mode coupling: interactive entry points should share one host-selection function"). Update coordinator-probe-auth-gap memory (restart-name fix now assigned here). Commit .drone-agent + vault per policy (feature branch only, never main).
- S8 (validation): pnpm -r run build; pnpm typecheck; pnpm lint (root); root pnpm test fast suite (NOTE: `pnpm -r run test` fails PRE-EXISTING at drone-core "No test files found" — root pnpm test is the real gate). LSP zero diagnostics on touched files. Manual smoke: `drone-agent --workflow bootstrap__swarm-memory` (TUI) — elicitations inline, completion reply renders, session stays live; `--output-plain` path unchanged; persona__create kick flow single-append.

## Validation criteria

- Root pnpm test fast suite green (192+ files, no regressions); all new tests pass.
- pnpm -r run build + typecheck + lint zero errors; LSP clean on touched files.
- Behavioral: --workflow mounts TUI (default), elicitations render inline, kick reply appears once with envelope, session continues or exits per continueSession; ctx.agent turns render in TUI and do not appear in main session history; double-append gone (session transcript shows exactly one user message per kick).
- Contract documented in AGENTS.md + vault concept page.
- No changes to: conversation service's main-session semantics, guardrails, or compaction; MCP; slash dispatch.

## Explicitly deferred

- Forward-context opt-in for ctx.agent (main-session history visibility).
- Per-step tool allowlists; `workflow` model-role (ADR 164 pattern); CLI --stay override.
- swarm.memory read-side bootstrap, stale-session UI review, librarian migration (phase-2 backlog).

## Sequencing

plan-web-port-auth-enforcement FIRST (its S3 rewrites the same swarm-memory files; its probe/default-URL changes are prerequisites context for S5 here). Then this plan on a fresh branch. Both plans saved as project memories: plan-web-port-auth-enforcement, plan-workflow-system-improvements.

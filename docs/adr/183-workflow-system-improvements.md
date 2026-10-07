---
tags: [decision, workflows, tui, engine, agent-assist]
related: [decisions/164-model-role-bindings.md, decisions/182-web-port-api-auth-enforcement.md, concepts/workflow-system.md, modules/drone-agent-tui.md, modules/drone-agent-plugins.md, concepts/session-management.md]
---

# 183 — Workflow system improvements: TUI host, agent assist, session continuation, kick contract

**Date**: 2026-09-01 · **Status**: Accepted · **Branch**: `feat/workflow-system-improvements` (off `feat/web-port-auth-enforcement` @ `b00df23`)

## Context

Four defects/design gaps, all found by running real workflows:

1. **Output-mode coupling**: `--workflow` always ran in plain-output mode — the workflow branch executed before any TUI mount, attaching a readline elicitation and a plain handler. Workflows lost streaming, tool renders, the status bar, and the inline elicitation UI, for no reason except dispatch order.
2. **No agent assist**: a workflow's only responder was the human (`elicit`). There was no way for a workflow to use the LLM as a step — e.g. "look at this host and tell me how the coordinator actually runs" — without spawning subagent processes or overloading elicitation.
3. **Hard exit**: workflows exited immediately on completion. `bootstrap__swarm-memory` in particular cries out for followups (enable the read side, review stale sessions), and nothing declared whether a given workflow even makes sense to continue.
4. **Broken kick handoff**: the kickMessage was appended to the session **twice** (callers pre-appended before `sendUserMessage`, which appends its own prompt — three copies of the bug: the `--workflow` branch, `/persona create`, `/skills create`), arrived unframed (the model couldn't tell instruction from report — swarm-memory's kick was a status dump), and no contract said what kickMessage is *for*. The user saw it as "the LLM complains about getting instructions twice and has no idea what to do with any of it."

## Decision

Four grilled decisions (Q1–Q4), plus two approved fold-ins:

**Q1 — TUI is the default workflow host.** `--workflow` without `--output-plain` mounts the full TUI with `initialWorkflow {name, args}`; the App runs the workflow once on mount. Elicitations render via the existing `ElicitationPrompt` wiring, tool activity streams through the existing conversation-event subscription, and the kick reply is a normal chat turn. `--output-plain` keeps the readline behavior (scripting UX); `--output-json` is untouched. Rule of thumb: interactive entry points should share one host-selection function, not re-derive output modes per branch.

**Q2 — `ctx.agent(prompt)`**: one synthetic turn through the full conversation machinery (registered tools, guardrails, conversation events → rendered by the TUI), returning the final assistant reply as a string. Backed by a **workflow-scoped ephemeral conversation** (`runtime/ephemeral-conversation.ts`): a fresh in-memory session manager + conversation service wired to the engine's LLM broker, prompt fragments, and runtime flags — created lazily on first agent call, shared by all agent calls in the run, discarded when the run ends. Nothing touches the main session's history or persistence. Full registered tools (no allowlists in v1 — workflow authors already write trusted, config-rewriting code); active provider/model (a `workflow` model-role per ADR 164 is a clean later extension). Rejected: subagent processes (heavyweight, no shared engine state), elicitation-overloading (a human-interaction primitive is not an LLM primitive).

**Q3 — Workflow-owned `continueSession`.** `DroneWorkflowResult.continueSession?: boolean` — the workflow knows whether followups make sense; no CLI override in v1. TUI: true → the session simply stays live after the kick reply; false/absent → the App exits programmatically. Plain mode: true → drop into `runInteractiveLoop` instead of exiting; JSON: no-op. The handoff context is the kickMessage alone — `toolResult` is never injected into the LLM's context (it's the machine-facing dump; duplicating it re-creates the confusion problem).

**Q4 — The kick contract.** (a) The runner wraps every kickMessage in a standard envelope: `Workflow <name> completed and handed off the following. Read it and continue the session appropriately:\n\n---\n<kickMessage>\n---` — one frame retroactively disambiguates the synthetic turn for all existing workflows. (b) Documented contract: **kickMessage is an instruction to the agent, not a report to the user**; reports belong in `toolResult`. (c) The double-append is removed at all three sites — `sendUserMessage` appends its own prompt, so callers must never pre-append. Synthetic-turn injection must be audited at BOTH layers (caller + service).

**Fold-ins** (approved during grilling): the restart unit-name fix (the workflow now *observes* the real unit/container name via ctx.agent, see below) and the coordinator `--help` HTTPS-default drift line (help claimed `COORDINATOR_HTTPS` controlled the default; the code hardcodes HTTPS on).

## Consequences

- `bootstrap__swarm-memory` is the flagship consumer: `continueSession: true`, agent-assisted service discovery (`detectServiceLaunch` asks the agent to check `systemctl list-units`/`docker ps` and report the exact restart command — fixing the `systemctl restart coordinator`-vs-`drone-coordinator` mismatch organically, confirm-gated and verified by re-probe as before), and an instruction-first kickMessage (report outcome in 2-4 bullets, surface pending restarts first, suggest the phase-2 followups).
- Persona and skills wizards get the envelope + single-append fixes retroactively; their test harnesses gained `agent` mocks (new required ctx member).
- The engine self-reference needed for `ctx.agent` uses a `captureEngine` holder (contextual typing of the engine literal is preserved; a placeholder-object approach broke it).
- Test notes: ink-testing-library frames are cleared by programmatic `exit()` — assertions must poll spies/state, not frames, after an exit path; the coordinator auth/workflow tests are unit-level (mock req/reply) by convention.
- Validation: build/typecheck/lint green; root `pnpm test` 192 files / 2,675 tests passed (+25 vs the 2,650 baseline); LSP clean via `pnpm typecheck` (editor LSP cache lagged).
- Deferred: forward-context opt-in for `ctx.agent`, per-step tool allowlists, `workflow` model-role, CLI `--stay` override, swarm.memory read-side bootstrap + stale-session review + librarian migration (phase-2 backlog).

## Related

- [[decisions/164-model-role-bindings]] · [[decisions/180-swarm-memory-bootstrap-workflow]] · [[decisions/182-web-port-api-auth-enforcement]]
- [[concepts/workflow-system]] · [[concepts/session-management]] · [[modules/drone-agent-tui]]
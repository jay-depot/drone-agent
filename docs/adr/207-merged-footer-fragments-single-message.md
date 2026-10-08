---
tags: [llm, prompt-fragments, prompt-cache, glm, guardrails, adr]
related:
  [
    modules/drone-agent.md,
    concepts/session-management.md,
    flows/tool-call-loop.md,
    decisions/153-pre-compaction-nudge.md,
    decisions/173-swarm-prompt-fragments.md,
    decisions/145-guardrail-reliability-features.md,
    meta/decision-bug-fixes-go-in-decisions.md,
  ]
---

# Merged footer fragments: single trailing system message (amends the phase-aware footer rendering)

**Summary**: Fixes a GLM-5.3-flash regression introduced by the phase-aware footer rendering (PR #99, `ce7aab2`): moving six stateful fragments to the conversation footer turned the request tail from ONE trailing `role:'system'` message (the proven-safe pre-#99 nudge shape) into a RUN of 2–6 consecutive system messages — an untrained template shape that made the model intermittently end rounds with narration and no tool call (plus elevated reasoning-only guardrail events). All footer fragments now merge into a single trailing system message joined by blank lines in both `buildFooterMessages` paths; topic delineation is preserved by each fragment's mandated top-level `# Heading`, and the header stays untouched so PR #99's prompt-cache win is preserved. Recorded as one ADR covering the parent feature (previously un-ingested), the regression diagnosis, and the fix, per decision-bug-fixes-go-in-decisions.

## Context

**The parent feature (PR #99, `ce7aab2`, merged 2026-09-09 — never previously ingested into this wiki).** Every registered prompt fragment used to render into the header system messages. Any fragment whose content changes between turns (notepad, todo list, swarm-memory RAG matches, LSP status, terminal sessions, startup banner) modified the request prefix, invalidating the provider's cached prompt prefix every turn. PR #99 added end-to-end support for `phase: 'header' | 'footer'` on `DronePromptFragment`: six stateful fragments (`startup-banner`, `notepad-current`, `todo-current-list`, `swarm-memory`, `lsp-status`, `terminal-active-sessions`) moved to `phase: 'footer'` and render as trailing `role:'system'` messages appended AFTER the conversation turns; only stable content remains in the header prefix. The engine gained `renderPromptFragmentsByPhase(phase)`, the context budget service gained `buildFooterMessages()`, and the engine kept a host-absent fallback. Cache stability was confirmed by auditing the request shape with `--debug llm`.

**The regression.** After #99 shipped, GLM-5.3-flash (OpenRouter/Parasail) intermittently ended rounds with thinking + narration but no tool call — the round terminated as a final text-only turn — and the reasoning-only broken-response guardrail fired more than usual. Symptom onset correlated with #99. The investigation (session `agent-1789055920680`, `reflect`/`code` personas) eliminated, in order:

1. **Context-window pressure** — 6% of ~1M tokens used; thinking blocks far too short to matter.
2. **Reasoning-token cap-yank** — a failing turn's raw OpenRouter `chat.completion` payload showed `reasoning_tokens: 6357` of 6915 completion tokens (92%, suspiciously near 6400), but the OpenRouter driver sends no explicit reasoning budget (`reasoning.effort` only), and the user's own failed-turn thinking block showed clean mid-plan reasoning far under any cap. Dead.
3. **Streaming delta-assembly loss** — the same raw payload showed `finish_reason: "stop"` with NO `tool_calls` field at all: the wire was faithful; the model genuinely emitted no tool call. Dead (and the non-streaming parsers were verified clean).
4. **Loop decision bug** — `continue ⇔ toolCalls.length > 0` after dedup is correct; specimens died on the NEXT iteration's text-only response. Normal mechanics, degenerate content.

**Root cause (user's hypothesis, adopted):** what changed is not "a system message at the tail" — single trailing system messages (nudges, one-shot system reminders) always landed there safely pre-#99 — it is that post-#99 the tail is a RUN of 2–6 consecutive `role:'system'` messages (six footer fragments plus drained one-shot reminders). Trailing system runs are an untrained shape for the chat template; a hybrid-thinking model decides "answer vs. keep working" on recency, reads a trailing instruction run as "instructions just given — respond to them", and narrates a plan instead of emitting the next tool call. The unifying signature: reasoning-only guard events and missing tool calls are the same failure — the emission sequence (reasoning → text → tool_calls) is cut partway and whatever survived is treated as complete. The guardrail's silent retries mask some occurrences, so the observed rate understates the true rate. Second-order effect: degenerate final turns persist in session history and amplify the failure (the model's own "one deliberate call, the git log:" narration tic becomes context).

## Decision

1. **Merge all footer fragments into ONE trailing system message.** `buildFooterMessages()` (context budget service) and the engine's host-absent fallback join the rendered footer fragments with `'\n\n'` and return a single `{ role: 'system', content }` message. Empty footer set → `[]` (no message at all).
2. **Topic delineation moves from message boundaries to headings.** The user's concern that message boundaries help the LLM tell topics apart is addressed by the project's own fragment convention (AGENTS.md): every fragment render starts with a top-level `# Heading` (`# Workspace`, `# Todo List`, `# Notepad`, `# LSP Status`, `# Swarm Memory`), and all footer fragments are the same role/topic class (session state), so one message with heading-delimited sections preserves the boundaries that matter.
3. **The prompt-cache win is preserved.** The header is untouched; stateful content still renders after the conversation; only the tail's message count changes (N → 1).
4. **Nudge/reminder placement is unchanged.** One-shot system reminders still drain after the merged footer message. A single trailing reminder is the pre-#99 proven-safe shape; the merge deliberately does not touch the one-shot drain semantics.
5. **A/B validation matrix (agreed with the user):** (1) control = the footer run (today's baseline); (2) merged single footer message — shipped here; (3) optional shape control = merged footer moved to header, separating "trailing content at all" from "run length". Step 1→2 is live A/B on GLM-5.3-flash (narration-without-tool-call incidence, reasoning-only guard notices, `reasoning_tokens` spread) using OpenRouter's activity API, which records exact per-request token usage including itemized reasoning tokens — no client-side estimation needed. Outcome pending real usage; step 3 is the fallback if the merge alone does not fix it.

## Implementation

- `drone-agent/src/runtime/context-budget-service.ts` — `buildFooterMessages()` returns `[{ role: 'system', content: fragments.join('\n\n') }]` with an empty-footer early return; inline comment cites the untrained-shape rationale.
- `drone-agent/src/runtime/plugin-engine.ts` — the host-absent `buildFooterMessages` fallback (~L1020) applies the same join (mirrors the service path).
- No changes to header rendering, the reminder queue, or drone-core types.

## Tests

- `drone-agent/test/context-budget-service.test.ts` — the "builds headers and footers" case now feeds two footer fragments and asserts exactly one merged message (`'# Footer One\n\n# Footer Two'`); new empty-footer case asserts `[]`.
- `drone-agent/test/plugin-engine.test.ts` — new "merges multiple footer fragments into a single trailing system message" case (two footer-phase fragments → one joined message).
- `test/conversation-service.test.ts` — the phase-ordering test needed no change: the single merged footer still lands between the last conversation turn and any queued reminder.

## Key Points

- **Template-shape sensitivity is real and model-specific.** A run of consecutive trailing system messages after conversation turns is untrained territory for some chat templates; a single trailing system message is universally trained (that is where nudge/reminders have always gone). When repositioning prompt content, A/B the whole request shape, not just the bytes.
- **Prove where the failure lives before touching code.** The raw OpenRouter `chat.completion` payload (`finish_reason: "stop"`, no `tool_calls`) is what killed the parser/loop/streaming theories in one step; every hypothesis after that was prompt-shape.
- **The guardrail hides part of the failure.** Broken-response retry silently re-rolls some degenerate turns, so observed symptom rates undercount the true rate — compare against the guardrail's own counters, not just visible failures.
- **Degenerate turns self-amplify.** A narration-without-action turn is persisted as a final assistant message, so the failure feeds future context. Fixing the shape fixes the feedback loop too.
- **Known follow-up (independent of this fix):** the OpenAI-compatible adapter never reads `finish_reason` — `length` truncation is indistinguishable from a real stop in the pipeline today.
- **Known follow-up (diagnostic):** OpenRouter's activity API gives exact per-request token usage (incl. itemized `reasoning_tokens`); use it instead of estimating when reasoning about budget behavior.

## Related

- [153-pre-compaction-nudge](153-pre-compaction-nudge.md) — the SystemReminderQueue whose single trailing system message is the proven-safe shape this fix restores
- [173-swarm-prompt-fragments](173-swarm-prompt-fragments.md) — the swarm fragment delivery that feeds one of the footer fragments
- session-management — the broken-response/reasoning-only guardrails whose event rate tracked this regression
- tool-call-loop — the request-assembly seam where footer messages are appended
- decision-bug-fixes-go-in-decisions — why this fix is an ADR amending its parent feature rather than a concept page

---
tags: [decision, compaction, plugin-engine, conversation-service, prompt-engineering]
related: [concepts/session-management.md, flows/tool-call-loop.md, modules/drone-agent-plugins.md, decisions/135-compaction-slash-command.md, decisions/145-guardrail-reliability-features.md]
---

# 153: Pre-compaction state-preservation nudge via system reminders

**Status**: Implemented (2026-08-22)

## Context

drone-agent's compaction ([[decisions/134-compaction-correctness-fix]]) summarizes the oldest turn slice into free-form prioritized prose, accumulates multiple discrete summaries at the session head, and evicts the oldest summary wholesale once the summary region exceeds `summaryBudgetPercent` (20%). That makes summaries a *lossy, evictable* place for durable session state — yet nothing tells the model that a compaction deadline is approaching. The model is expected to curate its notepad/todo continuously on its own initiative; there is no signal saying "persist what you need now."

Peer agents close this gap structurally: Pi's structured summary schema dedicates Goal / Next Steps / Critical Context sections (plus cumulative `<modified-files>` tracking) so critical state survives every compaction by construction; OpenCode V2's checkpoints carry objective/active-work/blockers/next-moves fields. drone-agent's incremental-slice design needs an equivalent guarantee without abandoning model-centric flexibility.

A second gap: only the conversation service's hardcoded guardrail nudges (`identicalCallNudgeActive`, `brokenResponseHintActive`) could inject non-persisted system messages. No plugin had any way to deliver a one-shot hint to the next LLM call without polluting session history.

## Decision

Two parts: a generalized delivery primitive, and a compaction-owned trigger using it.

### 1. SystemReminderQueue (generalized one-shot reminder primitive)

New module `drone-agent/src/runtime/system-reminders.ts`: a bounded FIFO queue (`MAX_SYSTEM_REMINDERS = 8`; entries beyond the cap are silently dropped so a buggy plugin cannot balloon prompts).

- The queue instance is created inside `createDronePluginEngine`.
- Plugins queue via the `_runtime` capability: `request('runtime').queueSystemReminder(content)` (optional access — absent capability degrades silently).
- The conversation service drains the queue when assembling outgoing messages (`provider.chat` payload build): each entry is appended as a `role: 'system'` message **after** the guardrail nudge blocks (guardrails address immediate loop/brokenness; reminders are advisory). Drain-once semantics make reminders one-shot by construction; they never enter session history.
- `drainSystemReminders()` / `clearSystemReminders()` were added to the public `DronePluginEngine` type. Unlike `resetStuckDetectors` (whose state lives host-side and must thread through `CreateDronePluginEngineOptions`), the queue lives engine-side, so the engine owns drain/clear directly — no host-callback indirection.
- Cleared on `clearSession()` so stale reminders never leak into a fresh session. Deliberately **not** reset on a new user message: reminder state is cumulative-growth state, unlike per-turn guardrail streaks.

### 2. Compaction plugin crossing detection

The compaction plugin owns the threshold math (its estimator is the single source of truth — no second usage-estimation path in the service). Inside `maybeCompact`, after metrics computation and before the soft-threshold early-bail:

- Band = `[softThresholdPercent − nudgeMarginPercent, softThresholdPercent]`. New config `compaction.nudgeMarginPercent` (drone-core types + TypeBox schema `Type.Optional(Percent)` + default **10**; `'compaction'` already deep-merges across config layers).
- **Edge-triggered**: fires once per excursion into the band. The `nudgeArmed` flag (in `RegistrationContext`, mirroring the `compactionInFlight` ref pattern) disarms on fire and re-arms only when usage falls back below the band floor — no nagging while the model works inside the band, no per-turn resets.
- **Skips**: `force` paths (manual `/compact` never warns), `compaction.enabled === false` (never warns about a compaction that isn't coming), and **overshoot** (usage clean past the soft threshold between evaluations — compaction handles it on the same evaluation; warning after the fact is noise).
- **Post-compaction quiet**: a `compactedDuringThisCall` flag suppresses the nudge for the remainder of an evaluation once compaction has acted (purge or summarize) — warning "compaction is coming" immediately after compaction just shrank the context is wrong. The next hook fire re-checks naturally.
- On fire, two channels: (1) queue the reminder text — names `notepad__manage` (working notes) and/or `todo__manage_list` (task state) conditionally on mounted-tool prefixes found via `registration.listMountedTools()`, includes a rounded tokens-until-threshold figure (nearest 100 below ~2000, else nearest 1k, shared formatter for both channels); (2) emit `{ kind: 'notice', content: '[Compaction in ~Xk tokens]' }` for the human (reuses the existing `notice` kind — yellow TUI rendering, no union/theme changes; note the `notice` variant carries `content`, unlike `compaction` events' `message`).

## Consequences

- The model gets a concrete, tool-named deadline signal before compaction can destroy unsaved context — closing the structural gap versus schema-based peers while keeping state curation in the model's hands.
- Every future plugin can deliver one-shot advisory hints via `_runtime.queueSystemReminder` (e.g. persona switches, workflow kicks). Follow-up logged: migrate the two hardcoded guardrail nudges onto the primitive to remove the remaining duplication.
- Reminders cost real tokens when they fire (~2 sentences); the cap bounds worst-case growth.
- The `armed` flag survives across turns (context object), consistent with cumulative-growth semantics.

## Tests

- New `system-reminders.test.ts` (6): FIFO order, one-shot drain, cap enforcement (9th dropped), post-drain reuse, clear-without-delivery.
- `compaction.test.ts` nudge matrix (8, exact estimator math against a 10k window — band [4000, 5000] tokens, `6 + ceil(chars/4)` per message): fire-once on band entry, quiet inside the band, overshoot never queues, disabled never queues/emits, `/compact` force never queues, re-arm below floor then second fire, reminder text contents (tool names + rounded figure + notice format), tool-clause omission without notepad/todo.
- Service-level (`conversation-service-events.test.ts`): queued reminder appears exactly once as a non-persisted system message and is gone from the next call; cleared reminders never reach the provider.
- drone-core round-trip: default resolves `nudgeMarginPercent: 10`; partial layer override merges.
- Harness: `captureRegistration` captures queued reminders + mutable mounted-tool names; `createMockEngine` gained a real queue (`__reminderQueue`) plus the two required engine members; `createFakeEngine` stubs them; 4 hand-built `DroneCompactionConfig` literals updated (log-plugin, prompt-file ×2, terminal).

## Implementation

- **Commit**: `e9f2725` ("feat(compaction): pre-compaction state-preservation nudge via system-reminder queue")
- **Files**: `drone-agent/src/runtime/system-reminders.ts` (new), `plugin-engine.ts`, `conversation-service.ts`, `plugins/compaction/index.ts`, `drone-core/src/config-types.ts`, `config-schema.ts`, tests (`system-reminders.test.ts` new; `compaction.test.ts`, `conversation-service-events.test.ts`, `helpers.ts`, `log-plugin.test.ts`, `prompt-file.test.ts`, `terminal.test.ts`, `drone-core/test/index.test.ts`)
- **Validation**: `pnpm -r run build` clean; `pnpm typecheck` + `tsc -p tsconfig.test.json` exit 0; LSP clean; root `pnpm lint` clean; root `pnpm test` 2006 passed / 9 skipped / 0 failed.

## Related

- [[concepts/session-management]] — Nudge band semantics alongside compaction triggering
- [[flows/tool-call-loop]] — Where the drain sits in the outgoing-message assembly
- [[modules/drone-agent-plugins]] — The compaction plugin row
- [[decisions/134-compaction-correctness-fix]] — The convergence loop whose evaluations host the crossing check
- [[decisions/135-compaction-slash-command]] — Manual `/compact` paths that skip the nudge via `force`
- [[decisions/145-guardrail-reliability-features]] — The hardcoded non-persisted nudges this primitive generalizes

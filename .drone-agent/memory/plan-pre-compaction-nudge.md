---
key: plan-pre-compaction-nudge
tags:
  - plan
  - compaction
  - plugin-engine
  - conversation-service
  - guardrails
created: 2026-08-22T19:33:16.108Z
updated: 2026-08-22T19:33:16.108Z
---

---
key: plan-pre-compaction-nudge
tags:
  - plan
  - compaction
  - plugin-engine
  - conversation-service
  - guardrails
created: 2026-08-22T06:45:00.000Z
updated: 2026-08-22T06:45:00.000Z
---

# Plan: Pre-Compaction State-Preservation Nudge

## Summary

When estimated context usage enters a warning band below the compaction soft threshold, the agent should get a one-shot, non-persisted system reminder telling it to persist anything it will need later (notepad / todo), and the human should see a one-shot `[Compaction in ~X tokens]` notice. This closes the gap versus Pi/OpenCode (which guarantee state capture at compaction time via summary schema/checkpoint fields): drone-agent currently relies wholly on model initiative with no deadline signal, while its own incremental-slice summaries are lossy free-form prose that eventually get evicted by the 20% summary-region budget.

The threshold math is owned by the **compaction plugin** (its estimator is the single source of truth — no second estimation path). Delivery uses a new **generalized one-shot system-reminder primitive** on `_runtime` (`queueSystemReminder`), drained by the conversation service at message-array assembly — mirroring how guardrail nudges (`identicalCallNudgeActive`, `brokenResponseHintActive`) are already appended as non-persisted `role:'system'` messages.

## Design decisions (locked in planning session)

| # | Decision | Outcome |
|---|----------|---------|
| 1 | Purpose | (a) state-preservation prompt to the model + (c) human token-countdown notice. (b) loss-preview content explicitly rejected. |
| 2 | Architecture | Compaction plugin computes crossing; generalized reminder API instead of purpose-built signal ref (precedent principle: prefer narrow, reusable engine primitives — cf. `listMountedTools` over `unmountAllNonRuntimeTools`). |
| 3a | API home | `queueSystemReminder(content: string)` exposed via the `_runtime` capability (precedent: `resetStuckDetectors` threaded through `CreateDronePluginEngineOptions`). NOT on DronePluginRegistration. |
| 3b | Structure | Engine-owned bounded queue, cap 8 entries, drain-all-on-next-call. Conversation service appends each as non-persisted system message then empties queue. Cleared on session clear. |
| 3c | Guardrails | Existing hardcoded guardrail nudges are NOT migrated onto the primitive in v1 (additive only). Follow-up logged. |
| 4a | Margin | New config `compaction.nudgeMarginPercent`, default 10. Band = `[softThreshold − margin, softThreshold]`. |
| 4b | Trigger semantics | Edge-triggered, one fire per excursion into the band; `armed` flag re-set only when usage falls below band floor (i.e., after compaction shrinks usage). No reset on new user message (cumulative-growth state, unlike guardrail streaks). Skip fire if usage overshot clean past soft threshold between evaluations (compaction fires same evaluation anyway). Skip entirely when `compaction.enabled === false`. Single tier only (no stronger second warning). |
| 5a | Reminder text | Names concrete tools (`notepad__manage`, `todo__manage_list`); includes rounded tokens-remaining figure; tool clause omitted when neither plugin is enabled. |
| 5b | Human notice | Reuse existing event `kind: 'notice'` (yellow TUI rendering exists). No new DroneConversationEvent union member. Message format `[Compaction in ~X tokens]`. |
| 5c | Number formatting | Stable rounding shared by both channels: nearest 100 below ~2000 remaining, else nearest 1000 (e.g. `~4k`, `~850`). |

## Current state (facts verified 2026-08-22)

- Compaction plugin: `drone-agent/src/plugins/compaction/index.ts` (676 lines). Hooks `onBeforePrompt` + `onAfterToolCall` run `runCompaction()` → `maybeCompact()`, guarded by `compactionInFlight: { value: boolean }` dep. `maybeCompact` computes metrics via `summarizeTokenCounts()` and resolves window via `resolveContextWindow()` (provider probe → derived fallback from `calculateFallbackContextWindow`). Emits `kind: 'compaction'` events.
- Config: `drone-core/src/config-types.ts` — `DroneCompactionConfig` (~line 178: enabled/strategy/softThresholdPercent/slicePercent/minTurnsToCompact/summaryMaxTokens/summaryBudgetPercent); defaults at ~line 534 (`softThresholdPercent: 50`, ...); `'compaction'` already listed in CONFIG_MERGE_SPEC merge array (~line 424). Schema: `drone-core/src/config-schema.ts` ~line 186 (`Type.Object({...})` with `Type.Optional(Percent)` fields).
- Guardrail nudge precedent: `drone-agent/src/runtime/conversation-service.ts` — outgoing message assembly ~line 645 pushes `{ role: 'system', content: ... }` for `identicalCallNudgeActive` / `brokenResponseHintActive`; flags cleared after use. Loop re-fetches tools per iteration; budget checks via `budgetService.buildSystemMessages()` + `ensureSafeBudget`.
- Engine: `drone-agent/src/runtime/plugin-engine.ts` — `CreateDronePluginEngineOptions` at line 170 with host callbacks (e.g. `resetStuckDetectors?: () => void` line 188); `_runtime` capability assembled inline at lines 777–783 BEFORE plugin registration loop; factory return object typed as `DronePluginEngine`.
- Session clear path: conversation service calls `sessionManager.clearSession()` at ~line 934; `resetStuckDetectors` implemented at ~line 953.
- Compaction tests exist: `drone-agent/test/compaction.test.ts` (actively maintained — last touched by #66).
- Test-mock pattern: `drone-agent/test/search.test.ts` `captureRegistration()` captures tools/fragments/hooks; registration mock includes `request`, `offer`, `mountTool`, `unmountTool`, `listMountedTools`.
- IMPORTANT: root `pnpm test` is the supported fast-suite entrypoint. `pnpm -r run test` is structurally broken (per-package scripts inherit repo-root vitest include globs → "No test files found"). Do not prescribe `pnpm -r run test`.
- After editing drone-core types: dependent packages resolve types from built dist/, so run `pnpm -r run build` before trusting LSP/typecheck in drone-agent.

## Steps

### Step 1 — Shared bounded reminder queue module (new file)

Create `drone-agent/src/runtime/system-reminders.ts` (pattern precedent: shared `DebugFlagRegistry` extracted rather than widening engine internals).

```typescript
export const MAX_SYSTEM_REMINDERS = 8;

export class SystemReminderQueue {
  private items: string[] = [];
  queue(content: string): void {
    if (this.items.length < MAX_SYSTEM_REMINDERS) this.items.push(content);
    // silently drop beyond cap — a buggy plugin must not balloon prompts
  }
  drainAll(): string[] {
    const out = this.items;
    this.items = [];
    return out;
  }
  clear(): void { this.items = []; }
}
```

Unit-testable in isolation (cap enforcement, FIFO order, clear).

### Step 2 — Wire queue through engine + expose on `_runtime`

File: `drone-agent/src/runtime/plugin-engine.ts`.

1. Instantiate `const systemReminders = new SystemReminderQueue()` inside the engine factory scope.
2. Add host-callback option `drainSystemReminders?: () => string[]` and `clearSystemReminders?: () => void` to `CreateDronePluginEngineOptions` (lines ~170–188), delegating to the queue instance (mirrors `resetStuckDetectors` threading).
3. In the inline `_runtime` object (lines ~778–783) add:
   ```typescript
   queueSystemReminder: (content: string) => systemReminders.queue(content),
   ```
4. Extend the engine's public return type/type alias so the conversation service can obtain `drainSystemReminders`/`clearSystemReminders`. If widening `DronePluginEngine` is too broad, pass the two functions directly into `createConversationService(...)` options instead (they originate in the same composition site, `index.tsx`).
5. Sweep consumers of `_runtime`/`DronePluginEngine` with LSP find-references before declaring done (project principle: cross-cutting interface changes break stale test mocks).

### Step 3 — Conversation service drains the queue

File: `drone-agent/src/runtime/conversation-service.ts`.

At the outgoing-message assembly (~line 645, where `identicalCallNudgeActive` messages are pushed):

```typescript
for (const reminder of drainSystemReminders()) {
  base.push({ role: 'system', content: reminder });
}
```

Order: append AFTER guardrail nudges (guardrails address immediate loop/brokenness; reminders are advisory). Drain happens once per LLM call → one-shot semantics for free. Add `clearSystemReminders()` invocation wherever stuck-detector state resets on session clear (~line 934 region). Update `CreateConversationServiceOptions` accordingly.

### Step 4 — Config: `nudgeMarginPercent`

Files: `drone-core/src/config-types.ts`, `drone-core/src/config-schema.ts`.

- Add `nudgeMarginPercent: number` to `DroneCompactionConfig` (after `summaryBudgetPercent`).
- Schema: `nudgeMarginPercent: Type.Optional(Percent)` inside the compaction Type.Object (~line 186).
- Default in `createDefaultAgentConfig`: `nudgeMarginPercent: 10`.
- No merge-spec change needed (`'compaction'` deep-merges already).

### Step 5 — Compaction plugin crossing detection

File: `drone-agent/src/plugins/compaction/index.ts`.

Inside `maybeCompact`, after `metrics` is computed each loop iteration (before the force early-bail logic):

```typescript
const softFrac = config.softThresholdPercent / 100;
const marginFrac = Math.max(0, config.nudgeMarginPercent) / 100;
const tokensUntilSoft = Math.max(
  0,
  Math.round((softFrac - metrics.usagePercent) * contextWindowTokens)
);

if (!input.options.force && armed && config.enabled) {
  if (
    metrics.usagePercent >= softFrac - marginFrac &&
    metrics.usagePercent <= softFrac
  ) {
    armed = false;
    const rounded = formatTokensRemaining(tokensUntilSoft);
    runtime?.queueSystemReminder(buildReminderText(rounded));
    emitEvent?.({ kind: 'notice', message: `[Compaction in ${rounded} tokens]` });
  }
}
if (metrics.usagePercent < softFrac - marginFrac) armed = true;
```

Semantics encoded here (all locked): edge-triggered; skip when `force` (manual `/compact` must not warn); skip overshoot (usage > soft ⇒ no warning, compaction proceeds same evaluation); re-arm below band floor; never fires when disabled. `armed` lives in `RegistrationContext` alongside `compactionInFlight` (NOT reset per user turn).

Helpers:

```typescript
function formatTokensRemaining(n: number): string {
  return n < 2000 ? String(Math.round(n / 100) * 100) : `~${Math.round(n / 1000)}k`;
}

function buildReminderText(fig: string): string {
  // Tool clause included only when notepad or todo tooling is present.
}
```

Plugin needs two new things in its registration context:
1. Access to `_runtime` for `queueSystemReminder`: `registration.request<{ queueSystemReminder(c: string): void }>('runtime')` (optional — degrade silently if absent).
2. Enabled-tool check for the text builder: `registration.listMountedTools()` returns canonical names; look for prefixes `notepad__` and `todo__`.

Draft reminder copy (final wording at implementation discretion, keep ≤ 2 sentences):

> Context is approaching the compaction threshold ({fig} tokens before older conversation turns are summarized). If there are constraints, decisions, discoveries, or next steps you will need later, persist them now using `notepad__manage` (working notes) or `todo__manage_list` (task state).

### Step 6 — Tests

1. NEW `drone-agent/test/system-reminders.test.ts`: queue cap (9th entry dropped), FIFO drain, clear empties.
2. EXTEND `drone-agent/test/compaction.test.ts` (follow existing captureRegistration-style mocks; extend the mock with `request` returning `{ queueSystemReminder: vi.fn() }` and `listMountedTools`):
   - crossing at exactly `soft − margin` fires once (reminder queued + notice emitted);
   - subsequent evaluations inside the band do NOT re-fire;
   - re-fire only after usage drops below band floor and rises again;
   - usage > soft (overshoot) does NOT queue a reminder;
   - `compaction.enabled: false` → nothing queued/emitted ever;
   - `/compact` force path (`force: true`) never queues;
   - reminder text contains `~Xk` figure and names `notepad__manage` / `todo__manage_list`;
   - tool clause absent when neither prefix present in `listMountedTools()`.
3. EXTEND conversation-service-level test (or add focused unit): queued reminder appears as a `role:'system'` message in the provider.chat payload exactly once, and is gone from the second call; cleared on session clear.
4. Config schema round-trip: default resolves with `nudgeMarginPercent: 10`; partial override merges (existing config test patterns in `drone-core`/root test dirs cover this style).

### Step 7 — Validation

Run in order; all must pass with zero errors:

1. `pnpm -r run build` FIRST (drone-core types changed; dependents resolve from dist/).
2. LSP diagnostics clean across workspace.
3. `pnpm -r run lint` (prettier will reformat — re-read files before further edits).
4. Root `pnpm test` (NOT `pnpm -r run test` — structurally broken, see current-state facts).

## Validation Criteria

- [ ] `queueSystemReminder` reachable from any plugin via `request('runtime')`; queue capped at 8; drains exactly once per LLM call as non-persisted system messages; cleared on session clear (unit-tested).
- [ ] Nudge fires exactly once per excursion into `[soft−10%, soft]`; silent inside band; re-arms below floor; skips overshoot/disabled/force cases (unit-tested matrix).
- [ ] Human sees one-shot `[Compaction in ~Xk tokens]` via existing `notice` event kind; no changes needed to DroneConversationEvent union/theme/app.tsx.
- [ ] Reminder text references concrete tool names conditionally on mounted tools; stable number formatting shared by both channels.
- [ ] `compaction.nudgeMarginPercent` added to types + schema + defaults (10); layer merge works unchanged.
- [ ] LSP diagnostics pass; `pnpm -r run build`, `pnpm -r run lint`, root `pnpm test` all pass.
- [ ] No change to compaction trigger timing, slice logic, safety trim, or guardrail retry paths.

## Explicit Non-Goals (deferred)

- Second-tier stronger reminder inside the band (single tier only for v1).
- Loss-preview content ("these turns will be summarized...").
- Migrating hardcoded guardrail nudges onto SystemReminderQueue (log follow-up insight/issue after landing).
- Any change to compaction trigger, slicing, summary-region eviction, or safety trim.
- Structured summary schema / cumulative file tracking (separate future feature).

## Housekeeping for the executing agent

- Work happens on branch `feat/pre-compaction-nudge` (created from main @ 96b68dda).
- Per AGENTS.md: commit `.drone-agent/` contents (including this memory file) with the change set on this feature branch. Final commit only AFTER insights/project memories are logged.
- After landing: log follow-up self-improvement insight proposing guardrail migration onto SystemReminderQueue; consider updating project wiki (`concepts/session-management`, ADR) describing the nudge band semantics.

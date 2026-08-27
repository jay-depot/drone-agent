---
key: plan-parallel-duplicate-tool-calls-guardrail
tags:
  - plan
  - guardrail
  - conversation-service
created: 2026-08-27T02:20:55.583Z
updated: 2026-08-27T02:20:55.583Z
---

# Plan: Parallel Duplicate Tool-Call Dedup Guardrail

## Summary

New `session.guardrail.deduplicateToolCalls` guardrail that collapses parallel identical tool calls within a single LLM response before processing. Prevents a degenerate loop where the model spews a massive batch of duplicate parallel tool calls (same name + same arguments), which currently blow up the session and execution pipeline. Semantically lossless (one call does what N would); emits a per-group `notice` as a context-health indicator.

## Design Decisions (confirmed with user)

- **Config location**: reuse `session.guardrail`, but NOT the `{ hintAfter, maxHints }` threshold shape. This guardrail is a plain on/off toggle.
  ```ts
  guardrail: {
    brokenResponses:        { hintAfter: 2, maxHints: 2 },
    reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
    identicalToolCalls:     { hintAfter: 2, maxHints: 3 },
    deduplicateToolCalls:   { enabled: true },   // default on
  }
  ```
- **Identity key**: `name + ':' + JSON.stringify(arguments)` — matches the existing identical-call streak guardrail's notion of identity exactly. Keep the first occurrence per group (preserving order).
- **Shared helper module**: `runtime/tool-call-utils.ts` (alongside `turn-utils.ts`) owning the single identity definition, so tightening the logic later (e.g. false-negative fixes like canonical key ordering) happens in one place. Refactor the existing streak guardrail's inline comparison onto the shared `toolCallSignature` helper.
- **Placement**: run dedup immediately after `const toolCalls = response.toolCalls ?? []`, BEFORE broken-response detection. Deduped list flows through to `appendAssistantMessage`, the `toolCallBatch` event, and `executeToolCalls` — no phantom calls in session or TUI.
- **Trigger**: collapse any batch with ≥2 identical calls (no minimum-count gating), gated only by `enabled`.
- **Observability**: one `kind: 'notice'` PER collapsed group (chatty but legible), e.g. `Deduplicated 2 identical parallel tool call(s) to 1 (file__read)`.
- **Stateless**: no cross-iteration counters → no reset wiring in `resetStuckDetectors()`/`clearSession()`.
- **Interaction with streak guardrail**: after dedup collapses a batch to a single call, the cross-iteration streak guardrail tracks it normally across subsequent iterations — they compose naturally, no special handling.

## Steps

### Step 1 — drone-core config (types + schema + defaults)

- `drone-core/src/config-types.ts`:
  - New type `DroneToolCallDedupConfig = { enabled?: boolean }`.
  - Add `deduplicateToolCalls?: DroneToolCallDedupConfig;` to `DroneGuardrailConfig`.
  - In `createDefaultAgentConfig` session.guardrail, add `deduplicateToolCalls: { enabled: true }`.
- `drone-core/src/config-schema.ts`: add `const ToolCallDedupSchema = Type.Object({ enabled: Type.Optional(Type.Boolean()) });` and `deduplicateToolCalls: Type.Optional(ToolCallDedupSchema)` to `GuardrailSchema`.
- Run `pnpm -r run build` (deps resolve from dist).

### Step 2 — shared helper module `runtime/tool-call-utils.ts`

New pure module (imports `DroneToolCall` type from drone-core). Export:

1. `toolCallSignature(call: { name: string; arguments: Record<string, unknown> }): string` — returns `name + ':' + JSON.stringify(arguments)`. THE single identity definition.
2. `deduplicateToolCalls(toolCalls: DroneToolCall[]): { deduped: DroneToolCall[]; collapsedGroups: { name: string; removed: number }[] }` — pure transform: preserves order, keeps first occurrence per signature, returns deduped list + per-group collapse counts (removed = count-1 per group, only groups with removed > 0).

### Step 3 — refactor streak guardrail onto shared helper

In `conversation-service.ts`, replace the inline identity check in the identical-call streak block (~line 900-910):

```ts
lastIdenticalToolCall.name === call.name &&
  JSON.stringify(lastIdenticalToolCall.arguments) ===
    JSON.stringify(call.arguments);
```

with `toolCallSignature(lastIdenticalToolCall) === toolCallSignature(call)`. Import `toolCallSignature` from `./tool-call-utils.js`.

### Step 4 — wire dedup into conversation loop

In `conversation-service.ts`:

- Import `deduplicateToolCalls` from `./tool-call-utils.js`.
- Resolve the toggle: `const dedupEnabled = guardrail.deduplicateToolCalls?.enabled ?? true;` (near the other resolved guardrail config; note this is not a threshold, so it stays a simple boolean — no `resolveThreshold`).
- Immediately after `const toolCalls = response.toolCalls ?? [];` (line ~816), BEFORE broken-response detection:
  ```ts
  let toolCalls = response.toolCalls ?? [];
  if (dedupEnabled && toolCalls.length > 1) {
    const { deduped, collapsedGroups } = deduplicateToolCalls(toolCalls);
    for (const g of collapsedGroups) {
      emit({
        kind: 'notice',
        content: `Deduplicated ${g.removed} identical parallel tool call(s) to 1 (${g.name})`,
      });
    }
    toolCalls = deduped;
  }
  ```
  (Change `const toolCalls` → `let toolCalls`.) The deduped `toolCalls` then flows through the existing broken-response detection, append, `toolCallBatch` event, and `executeToolCalls` unchanged.

### Step 5 — tests

- New `drone-agent/test/tool-call-utils.test.ts`: unit tests for `toolCallSignature` (stability, key-order sensitivity matches streak) and `deduplicateToolCalls` (order preserved, first occurrence kept, per-group counts, no-op on unique batch, collapses multiple distinct groups, ignores `id` in key).
- Add tests to `drone-agent/test/conversation-service-guardrails.test.ts`:
  - Defaults test (line ~513) asserts `deduplicateToolCalls?.enabled === true`.
  - Batch of identical parallel calls → deduped, notice emitted per group, single execution (assert `executeTool` called once / results reflect one call).
  - Batch with mixed distinct + duplicate calls → only dups collapsed.
  - `deduplicateToolCalls: { enabled: false }` → batch passes through unchanged, no notice.
  - Streak guardrail still works after refactor (existing tests cover; verify they pass).
- Verify no existing tests break (config defaults test, token-estimate tests that embed guardrail shape).

### Step 6 — docs

- `AGENTS.md` guardrail table: add `deduplicateToolCalls.enabled` row (default true, "collapse parallel identical tool calls in one response").
- Wiki (in `/home/unleet/Obsidian/drone-agent-project`): update `concepts/session-management.md` Guardrails section table + prose; update `decisions/145-guardrail-reliability-features.md` Related; add **ADR 166** `decisions/166-parallel-duplicate-tool-call-dedup.md`; add row to `decisions/index.md` (latest is 165); update `index.md` summary if needed.

### Step 7 — validation

- `pnpm -r run build` — zero errors.
- `pnpm lint` (eslint + prettier) — zero errors.
- LSP diagnostics — zero errors across touched files (config-types.ts, config-schema.ts, tool-call-utils.ts, conversation-service.ts, tests).
- `pnpm test` (fast suite) — all pass, including new dedup tests + existing streak tests.

## Validation Criteria

- All LSP checks pass (typescript).
- `pnpm -r run build` and `pnpm lint` pass with zero errors.
- Fast test suite (`pnpm test`) passes; new dedup tests and existing streak-guardrail tests green.
- A single-response batch of N identical parallel calls executes exactly once and emits one per-group `notice`.
- `enabled: false` leaves the batch untouched with no notice.
- The streak guardrail's inline identity check is replaced by the shared `toolCallSignature` helper (no duplicate identity logic remains).
- Config schema validates `deduplicateToolCalls.enabled` and `createDefaultAgentConfig` defaults it to `true`.

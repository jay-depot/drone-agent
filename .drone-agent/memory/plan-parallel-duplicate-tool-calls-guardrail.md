---
key: plan-parallel-duplicate-tool-calls-guardrail
tags:
  []
created: 2026-08-27T02:20:55.583Z
updated: 2026-08-27T02:28:54.911Z
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
- `drone-core/src/config-types.ts`: new `DroneToolCallDedupConfig = { enabled?: boolean }`; `deduplicateToolCalls?: DroneToolCallDedupConfig` on `DroneGuardrailConfig`; default `deduplicateToolCalls: { enabled: true }` in `createDefaultAgentConfig`; exported from `drone-core/src/index.ts`.
- `drone-core/src/config-schema.ts`: `ToolCallDedupSchema = Type.Object({ enabled: Type.Optional(Type.Boolean()) })`; `deduplicateToolCalls` field on `GuardrailSchema`.
- Ran `pnpm -r run build`.

### Step 2 — shared helper module `runtime/tool-call-utils.ts`
New pure module (imports `DroneToolCall` type). Exports `toolCallSignature(call)` → `name + ':' + JSON.stringify(arguments)` and `deduplicateToolCalls(toolCalls)` → `{ deduped, collapsedGroups }` (preserves order, first occurrence per signature, per-group `{name, removed}` counts, ignores `id`).

### Step 3 — refactor streak guardrail onto shared helper
Replaced the inline `name === && JSON.stringify ===` comparison in the identical-call streak block with `toolCallSignature(lastIdenticalToolCall) === toolCallSignature(call)`. Imported `toolCallSignature` from `./tool-call-utils.js`.

### Step 4 — wire dedup into conversation loop
- Imported `deduplicateToolCalls` + `toolCallSignature` from `./tool-call-utils.js`.
- Resolved `dedupToolCallsEnabled = guardrail.deduplicateToolCalls?.enabled ?? true` (plain boolean, not a threshold).
- Immediately after `let toolCalls = response.toolCalls ?? []`, if `dedupToolCallsEnabled && toolCalls.length > 1`, ran `deduplicateToolCalls`, emitted one `notice` per collapsed group, reassigned `toolCalls = deduped`. Deduped list flows through broken-response detection, append, `toolCallBatch`, `executeToolCalls` unchanged.

### Step 5 — tests
- New `drone-agent/test/tool-call-utils.test.ts` (10 tests): `toolCallSignature` stability, key-order sensitivity matches streak, distinguishes name/args; `deduplicateToolCalls` order-preserving, first-occurrence-kept, per-group counts, no-op on unique, multi-group collapse, ignores `id`, no input mutation.
- Extended `drone-agent/test/conversation-service-guardrails.test.ts` (14 tests): defaults asserts `deduplicateToolCalls?.enabled === true`; identical-batch deduped with one notice + single execution; mixed batch collapses only dups (3 executions); `enabled: false` passthrough with no notice. Existing streak tests still pass after refactor.

### Step 6 — docs
- `AGENTS.md` guardrail table + prose paragraph.
- Wiki (vault `/home/unleet/Obsidian/drone-agent-project`): `concepts/session-management.md` table + prose + Related; `flows/tool-call-loop.md` new dedup step; `modules/drone-agent.md` guardrails bullet; `modules/drone-core.md` config-types + config-schema lines; `decisions/145` Related; **ADR 166** `decisions/166-parallel-duplicate-tool-call-dedup.md`; `decisions/index.md` row + count 167; `index.md` latest-ADR pointer + row; `log.md` ingest entry; `meta.json` checkpoint.

### Step 7 — validation
- `pnpm -r run build` — zero errors.
- `pnpm lint` (eslint + prettier) — zero errors.
- LSP diagnostics — zero errors across touched files.
- `pnpm test` fast suite — 2310 passed / 9 skipped.

## Validation Criteria
- All LSP checks pass (typescript). ✓
- `pnpm -r run build` and `pnpm lint` pass with zero errors. ✓
- Fast test suite passes; new dedup + streak tests green. ✓ (2310 passed / 9 skipped)
- Single-response batch of N identical calls executes once + emits per-group notice. ✓
- `enabled: false` leaves batch untouched with no notice. ✓
- Streak guardrail inline identity check replaced by shared `toolCallSignature` (no duplicate identity logic). ✓
- Config schema validates `deduplicateToolCalls.enabled`, defaults to `true`. ✓

## COMPLETION SUMMARY (2026-08-27)

All 7 steps implemented and validated. Commits:
- `14d7acc` plan memory commit
- `cb11a8c` implementation (drone-core types/schema/defaults, runtime/tool-call-utils.ts, conversation-service refactor + wiring, tests, AGENTS.md docs)
- Wiki ingest committed to vault `main` as `064d39c` (ADR 166 + concept/flow/module/decisions/index updates + log + meta.json)

Full fast suite 2310 passed / 9 skipped; build, lint, LSP clean. Feature branch `feat/guardrail-parallel-duplicate-tool-calls`.

**Execution notes / lessons:**
1. `file__apply_diff` fuzz-matching can misfire and corrupt files when hunks are too small (lost the `DroneToolCallDedupConfig` type declaration and duplicated the file tail once). Always re-read after edits and keep hunks anchored with sufficient context.
2. The LSP diagnostic for `dedupToolCallsEnabled` was initially stale (reported before the declaration edit re-indexed). Cross-check against `tsc -b` build output rather than trusting a single LSP read.
3. When running vitest filters from the monorepo root, pass the full `drone-agent/test/...` path — vitest resolves paths from the workspace root, not the package dir.
4. Prettier (`pnpm lint`) reformatted the plan memory file; remember to re-read files after lint before further edits.

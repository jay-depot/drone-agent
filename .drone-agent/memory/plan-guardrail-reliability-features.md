---
key: plan-guardrail-reliability-features
tags:
  - plan
  - guardrail
  - reliability
  - conversation-service
  - complete
created: 2026-08-17T21:19:39.487Z
updated: 2026-08-18T04:27:09.030Z
---

# Plan: Guardrail & Reliability Features — COMPLETE

## Summary

All three guardrail features implemented and committed on branch `feat/guardrail-reliability-features`. The code-review rework (items 1-11 below) is complete. All validation criteria pass: `pnpm -r run build`, LSP (zero errors), `pnpm lint`, and the fast test suite (1987 passed / 9 skipped / 0 failed).

## Work Completed (rework)

### Blocking
1. **Guardrail config optionality** — Made `DroneGuardrailConfig` and `DroneGuardrailThresholdConfig` fields optional to match the schema. Added default resolution in `conversation-service.ts` (`DEFAULT_GUARDRAIL` + `resolveThreshold` → `resolvedGuardrail`) so callers never null-check. This resolves the `config.ts:44` TS2322.
2. **Rebuilt drone-core** (`pnpm -r run build`).
3. **Fixed stale `sessionConfig` fixtures** in `drone-core/test/token-estimate.test.ts` (+ guardrail to both fixtures, 4 TS2741 resolved). Also added `guardrail` to stale fixtures in `context-budget-service.test.ts`, `log-plugin.test.ts`, `prompt-file.test.ts`, `terminal.test.ts`.

### Blocking — missed plan deliverables
4. **Wired `resetStuckDetectors` into `_runtime` capability** — Added `resetStuckDetectors?` to `CreateDronePluginEngineOptions`, threaded it through `createDronePluginEngine`, and exposed it in the `_runtime` capability. `index.tsx` wires it via a mutable ref (`resetStuckDetectorsRef`) since the conversation is created after the engine.
5. **`resetStuckDetectors()` now also resets broken-response counters** — reset `emptyResponseCount`/`reasoningOnlyResponseCount` (previously split out per-tier) in both `resetStuckDetectors` and `clearSession`.

### Code quality
6. **Extracted duplicated tool-execution pipeline** — Added a shared `executeToolCalls()` helper used by both the primary tool-call path and (formerly) the hint path. Handles execute/truncate/buffer/stuck-detect/emit/append/hooks/images.
7. **`brokenResponseHintActive` is now used (not dead)** — Feature 1 phase-2 hint injection is flag-based (mirrors `identicalCallNudgeActive`): on the first phase-2 attempt it sets the flag and continues; the next loop iteration injects the hint into the LLM messages. This fixes the two broken-response hard-limit test failures (the old separate `provider.chat` hint call consumed an extra queued response so the limit never fired).
8. **Feature-1 tier selection fixed** — Split the single `brokenResponseCount` into `emptyResponseCount` and `reasoningOnlyResponseCount` so truly-empty and reasoning-only thresholds are independent.

### Minor
9. Removed unused `DroneChatMessage` import in `index.tsx`; used the `args` param.
10. Added trailing newline to `conversation-service-guardrails.test.ts`.
11. Included tool args in the `onIdenticalToolCallLimitReached` prompt (`toolName(...)`).

## Regression fixes (pre-existing failures on base branch)
- **Broken-response hard limit (2 tests)**: fixed by flag-based hint injection (see item 7).
- **Identical-call preempting iteration limit (2 tests)**: reordered the iteration-limit check to run BEFORE the identical-call hard limit, and reset `identicalToolCallStreak` when the iteration limit is continued. The `iteration-limit` and `persona-toolCallLimit` tests now pass; the guardrail identical-limit test (hintAfter=2, maxHints=0) still throws at streak 3 as expected.

## Validation criteria (all met)
- pnpm -r run build passes
- LSP passes with zero errors
- pnpm -r run lint passes
- pnpm -r run test (fast suite) passes (129 files passed, 1 skipped; 1987 tests passed)
- resetStuckDetectors reachable via _runtime capability
- No dead code / unused vars / duplicated tool-execution block

## Config (under `session.guardrail`)
```ts
brokenResponses: { hintAfter: 2, maxHints: 2 },
reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
identicalToolCalls: { hintAfter: 2, maxHints: 3 },
```
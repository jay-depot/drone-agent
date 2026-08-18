---
key: plan-guardrail-reliability-features
tags:
  - plan
  - guardrail
  - reliability
  - conversation-service
  - in-review
created: 2026-08-17T21:19:39.487Z
updated: 2026-08-18T03:30:04.096Z
---

# Plan: Guardrail & Reliability Features — NEEDS REWORK

## Summary

All three guardrail features implemented and committed on branch `feat/guardrail-reliability-features` (commit `d35b300`). A code review found blocking issues: the branch does not typecheck, and two plan deliverables were missed.

## Outstanding Items

### Blocking — branch does not compile
1. Reconcile guardrail config optionality: `DroneSessionConfig.guardrail` typed fully-required but `GuardrailSchema` makes all fields optional → hard TS2322 at `config.ts:44`. Make type Partial or schema required.
2. Rebuild drone-core (`pnpm -r run build`) — test file resolves stale dist/, fails on `DroneGuardrailConfig` import and `session.guardrail` access.
3. Fix stale `sessionConfig` fixtures in `drone-core/test/token-estimate.test.ts` (lines 176-178, 244-246) — missing required `guardrail` → TS2741 (4 errors).

### Blocking — missed plan deliverables
4. Wire `resetStuckDetectors` into `_runtime` capability (plan step 5) — `plugin-engine.ts` ~770 still only exposes subagentId/persona/isSubagent/flags.
5. `resetStuckDetectors()` must also reset `brokenResponseCount` — currently omits it, disagreeing with sendUserMessage's fresh-turn reset.

### Code quality
6. Remove ~100-line duplicated tool-execution pipeline in Feature-1 hint path — extract shared execution block used by both primary and hint responses.
7. Delete or use `brokenResponseHintActive` — declared/reset but never read or set true (dead code).
8. Fix Feature-1 tier selection — phase-2 hint text and retry counting use same `brokenResponseCount` for both tiers; truly-empty vs reasoning-only thresholds/hints may be conflated.

### Minor
9. `index.tsx` unused `DroneChatMessage` import + unused `args` param in onIdenticalToolCallLimitReached.
10. Test file missing trailing newline.
11. Consider including tool args in onIdenticalToolCallLimitReached user prompt.

## Validation criteria (must pass before re-marking complete)
- pnpm -r run build passes
- LSP passes with zero errors
- pnpm -r run lint passes
- pnpm -r run test (fast suite) passes incl. new guardrail tests
- resetStuckDetectors reachable via _runtime capability
- No dead code / unused vars / duplicated tool-execution block

## Config (under `session.guardrail`)
```ts
brokenResponses: { hintAfter: 2, maxHints: 2 },
reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
identicalToolCalls: { hintAfter: 2, maxHints: 3 },
```
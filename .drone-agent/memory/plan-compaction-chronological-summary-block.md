---
key: plan-compaction-chronological-summary-block
tags:
  - compaction
  - plan
  - session-manager
  - ordering
  - bugfix
created: 2026-08-23T23:57:26.942Z
updated: 2026-08-23T23:57:26.942Z
---

# Plan: Chronological Compaction Summary Block (fix newest-first ordering)

Branch: `fix/compaction-summary-order` (created off main, clean tree)

## Summary
Compaction summaries reach the LLM newest-first. Root cause: `prependSystemTurn()` (`drone-agent/src/runtime/session-manager.ts`) does `turns.unshift()`, so each new summary lands IN FRONT of prior ones; storage order flows untouched into `getMessages()` (LLM context) and the log plugin snapshots. No consumer reorders; no prior decision chose this (emergent artifact enshrined by test comments).

## Decisions (user-approved)
1. Fix at the source: chronological storage, not per-consumer sorting.
2. Keep API name/signature `prependSystemTurn(content, opts)`; redefine insertion = immediately AFTER the leading run of summary-kind turns. New invariant: summaries form one contiguous chronological block at array head `[S1, S2, S3, ...live...]`. Uniform rule regardless of new turn kind (only prod caller is compaction; two kind-less test call sites unaffected).
3. Scope: code + tests ONLY. No ADR/vault steps (user handles docs in separate workflow).

## Forced consequences (mechanical)
- Self-purge (`compaction/index.ts:~311`): drop target flips `summaryTurns.at(-1)!` -> `summaryTurns[0]!`.
- Capability `dropOldestSummaries` (`compaction/index.ts:~734`): `.slice(-count)` -> `.slice(0, count)` (otherwise silently drops NEWEST after flip).
- `/compact status.summaries[]` display order flips to oldest-first (no code change; map over getSummaryTurns()).
- Stale comments: `compaction/index.ts:~347-350` ("Summaries are prepended at the head...") and test comment "getSummaryTurns() is newest-first" (~461).
- drone-core types carry NO ordering claims — untouched.

## Steps
1. **[coder]** `src/runtime/session-manager.ts` — rewrite `prependSystemTurn`: compute `insertIndex` by advancing past `turns[i].kind === 'summary'` from 0, then `turns.splice(insertIndex, 0, turn)`. Return turn as before.
2. **[coder]** `src/plugins/compaction/index.ts` — self-purge target `.at(-1)!` -> `[0]!`; update stale head/tail comment (~347).
3. **[coder]** same file — `dropOldestSummaries`: `.slice(-count)` -> `.slice(0, count)`.
4. **[tester]** `test/session-manager.test.ts` — keep single-prepend head test; ADD: two prepends yield `[S1, S2]`; ADD: `appendUser('u')` between/after prepends still yields `[S1, S2, u]` (contiguity); assert `getSummaryTurns()` oldest-first.
5. **[tester]** `test/compaction.test.ts` — invert ~10 order-pinning asserts (lines ≈461-469, 801, 1402-1408, 1456-58, 1463-66, 1495-96, 1520-26+1546, 1759, 1805, 1829-30, 1852-54); update seeded-purge fixtures (379-380, 527-528, 755, 819, 936-939, 1323); ADD regression: multi-round forced compaction -> `getMessages()` contains summary contents in chronological order (S1 text before S2 text).
6. **[reviewer]** Sweep: LSP find_references on `prependSystemTurn` + `getSummaryTurns`; grep residual positional accessors (`at(-1)`, `slice(-`, `[0]`) near summary code; confirm no other consumer assumes reversed order.
7. **[validator]** Validation criteria below.

## Validation Criteria
- [ ] Zero LSP errors/warnings workspace-wide (incl. test files)
- [ ] `pnpm -r run build` passes
- [ ] `pnpm -r run lint` passes (eslint + prettier)
- [ ] `pnpm test` fast suite green (focus: compaction.test.ts, session-manager.test.ts)
- [ ] Grep confirms no surviving `.slice(-` / `.at(-1)` on summary-turn collections

Status: Plan finalized 2026-08-23. Ready for execution by `code` persona.
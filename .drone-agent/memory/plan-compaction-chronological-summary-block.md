---
key: plan-compaction-chronological-summary-block
tags:
  - compaction
  - plan
  - session-manager
  - ordering
  - bugfix
  - completed
created: 2026-08-23T23:57:26.942Z
updated: 2026-08-24T00:33:54.957Z
---

# Plan: Chronological Compaction Summary Block (fix newest-first ordering)

Branch: `fix/compaction-summary-order` (created off main, clean tree)

## Summary
Compaction summaries reach the LLM newest-first. Root cause: `prependSystemTurn()` (`drone-agent/src/runtime/session-manager.ts`) does `turns.unshift()`, so each new summary lands IN FRONT of prior ones; storage order flows untouched into `getMessages()` (LLM context) and the log plugin snapshots. No consumer reorders; no prior decision chose this (emergent artifact enshrined by test comments).

## Decisions (user-approved)
1. Fix at the source: chronological storage, not per-consumer sorting.
2. Keep API name/signature `prependSystemTurn(content, opts)`; redefine insertion = immediately AFTER the leading run of summary-kind turns. New invariant: summaries form one contiguous chronological block at array head `[S1, S2, S3, ...live...]`. Uniform rule regardless of new turn kind (only prod caller is compaction; two kind-less test call sites unaffected).
3. Scope: code + tests ONLY. No ADR/vault steps (user handles docs in separate workflow).

## Steps
1. **[coder]** `src/runtime/session-manager.ts` — rewrite `prependSystemTurn`: compute `insertIndex` by advancing past leading summary-kind turns from 0, then `turns.splice(insertIndex, 0, turn)`.
2. **[coder]** `src/plugins/compaction/index.ts` — self-purge target `.at(-1)!` -> `[0]!`; fix stale head/tail comment (~347).
3. **[coder]** same file — `dropOldestSummaries`: `.slice(-count)` -> `.slice(0, count)`.
4. **[tester]** `test/session-manager.test.ts` — ADD multi-prepend chronology + contiguity tests (existing single-summary asserts unchanged under new semantics).
5. **[tester]** `test/compaction.test.ts` — invert positional order asserts; add getMessages() chronological regression test.
6. **[reviewer]** Sweep find_references + positional-accessor grep.
7. **[validator]** Full validation battery.

## Validation Results
- [x] Zero LSP errors/warnings on all four touched files (one pre-existing style hint only)
- [x] `pnpm -r run build` passes (all 8 packages)
- [x] Root `pnpm lint` passes (eslint --fix + prettier; note: `pnpm -r run lint` does NOT exist in this repo)
- [x] Focused run: session-manager.test.ts + compaction.test.ts = 72/72 green
- [x] Full fast suite: 137 files, 2071 tests passed (9 skipped, integration-gated)
- [x] Grep sweep clean: no residual `.at(-1)`/`.slice(-` on summary-turn collections (remaining hits are live-tail ops or unrelated files)

## Completion Summary (2026-08-24)
Executed to completion by the `code` persona. Commit `3fb847b` on branch `fix/compaction-summary-order` (+112/-19 across 6 files: session-manager.ts, compaction/index.ts, both test files, plus this memory file and a planning-session insight). Key execution notes:
- Most seeded compaction test fixtures needed NO edits: their assertions key off variable names (`s1.id`, `oldest.id`) rather than array positions, and creation order maps directly to array order under chronological semantics. Only genuinely positional assertions changed.
- `/compact status.summaries[]` display order flipped to oldest-first automatically (maps over getSummaryTurns()); assertion updated, no production change needed there.
- Plan line numbers had drifted slightly by execution time (~311 -> ~307); content-anchored patching absorbed it without issue.
- Docs/ADR steps intentionally excluded per user decision (user runs separate doc-update workflow).
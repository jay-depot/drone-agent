---
tags: [decision, compaction, session-management, ordering]
related: [concepts/session-management.md, entities/Session.md, decisions/125-compaction-summary-eviction.md, decisions/133-compaction-oldest-turns-helper-consolidation.md, decisions/142-compaction-turn-granularity-fix.md, decisions/153-pre-compaction-nudge.md]
---

# 158: Chronological Compaction Summary Block

**Status**: Implemented (2026-08-24)

## Context

Compaction summaries appeared in the LLM context **newest-first**, backwards relative to the live conversation (which runs oldest→newest). Root cause: `prependSystemTurn()` (`drone-agent/src/runtime/session-manager.ts`) inserted every new summary turn with `turns.unshift()` — so each summary landed *in front of* all previous ones. Storage order flowed untouched into `getMessages()`, which is exactly what the conversation service sends to the LLM, so after N compactions the model read `[S_N … S_2, S_1, live turns…]`.

Nothing ever chose this ordering. No ADR specified it, no consumer deliberately relied on it, and nothing re-sorted at presentation time. It was an emergent artifact of "prepend" naming that later got **enshrined**: [[decisions/125-compaction-summary-eviction]] set the self-purge drop target to `getSummaryTurns().at(-1)` (correct only because storage was reversed), test comments asserted "`getSummaryTurns()` is newest-first", and [[decisions/133-compaction-oldest-turns-helper-consolidation]] documented the resulting `[S_newest…S_oldest, normal_oldest…]` layout as fact. The same reversed order leaked into the log plugin's JSON session snapshots.

## Decision

**Store summaries chronologically.** The session manager maintains one invariant: all summary turns form a single **contiguous chronological block at the head of the turns array** — `[S1, S2, S3, …live turns]`. Every consumer gets correct order for free; nothing sorts downstream.

### 1. `prependSystemTurn` insertion point (Option A)

Keep the API name and signature `prependSystemTurn(content, opts?)`; redefine only the insertion point. Instead of `turns.unshift(turn)`, compute the insert index by advancing past any leading run of `kind === 'summary'` turns from index 0, then splice there. The rule is uniform regardless of the new turn's kind (the only production caller passes `kind: 'summary'`). Rejected alternatives: sorting at every presentation point (LLM context assembly, log snapshots — two touchpoints and two conflicting orderings forever), or a new `appendSummaryTurn` primitive with deprecation churn (cosmetic rename can happen later; a bug-fix branch shouldn't rename APIs).

### 2. Forced consequence: self-purge flips head-ward

With chronological storage, the compaction self-purge's drop target flips from `summaryTurns.at(-1)!.id` back to `summaryTurns[0]!.id` — but now `[0]` genuinely *is* the oldest summary, restoring [[decisions/125-compaction-summary-eviction]]'s intent with simpler indexing.

### 3. Forced consequence: `dropOldestSummaries` slice direction

The `/compact drop N` capability computed ids via `getSummaryTurns().slice(-count)` — correct under reversed storage, but silently **newest-selecting** once storage flipped. Changed to `.slice(0, count)`. This site was found by grepping positional accessors over derived collections, not by following symbol references — derived accessor methods carry hidden directional semantics.

### 4. Display surfaces flip automatically

`/compact status.summaries[]` and `/compact show` map over `getSummaryTurns()` and now list oldest-first without production changes. Log-plugin JSON snapshots inherit chronological order for free. `drone-core` types carry no ordering claims, so nothing upstream needed touching.

## Key Points

- There is no session persistence/resume anywhere in drone-agent, so changing storage order has zero backward-compatibility surface.
- Safety trim, budget estimation, token counting, and `oldestNonSummaryIndex` are order-agnostic (they skip or count summaries); unaffected — verified by reference sweep plus positional-accessor grep.
- Most seeded test fixtures needed **no edits**: assertions keyed off variable identity (`s1.id`, `.some(t => t.id === …)`) survive any storage order. Only genuinely positional assertions (`[0]`, `.at(-1)`) required flipping. When changing an ordering invariant, enumerate positional accessors during planning — they, not fixture sites, are the real edit set.
- Two intentional newest-at-tail assertions remain in tests (pinning that new chunks land at the block tail); naive greps for residual `.at(-1)` will hit them.
- New regression coverage: consecutive-prepend chronology and head-block contiguity (session-manager tests), plus a multi-round compaction test asserting `getMessages()` yields summaries in creation order — the user-visible symptom, pinned directly.
- Validation: LSP clean, build + root `pnpm lint` clean, focused suites 72/72, full fast suite 2071 passed / 9 skipped (commits `4cb97d8`, `3fb847b`, `e15a274` on `fix/compaction-summary-order`).

## Related

- [[decisions/125-compaction-summary-eviction]] — Original eviction fix; its `.at(-1)` mechanic is superseded (intent preserved)
- [[decisions/133-compaction-oldest-turns-helper-consolidation]] — Documented the old reversed layout; helper semantics unchanged
- [[concepts/session-management]] — Compaction triggering, self-purge, and summary-block invariant
- [[entities/Session]] — `DroneSessionTurn` shape and turn ordering guarantees

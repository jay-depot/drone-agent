---
tags: [decision, compaction, slash-command, bugfix]
related: [concepts/session-management.md, modules/drone-agent-plugins.md, decisions/134-compaction-correctness-fix.md, decisions/135-compaction-slash-command.md, decisions/144-compaction-fragment-integration.md]
---

# 148: `/compact` manual-force skips the soft-threshold gate

**Status**: Implemented (2026-08-19)

## Context

The `/compact` slash command (and `/compact --all`) printed success messages ("Compacted oldest non-summary turns") but did **not** actually compact a session whose context usage was at or below the soft threshold. The user reported: "the `/compact` command doesn't actually cause compaction. It prints success messages, but it looks like it's not actually wired up. Automatic compaction seems to be working fine."

## Root cause

`maybeCompact`'s convergence loop (in `plugins/compaction/index.ts`) starts with a gate:

```ts
if (metrics.usagePercent <= softThreshold) {
  break;  // ← early exit before any compaction
}
```

This gate is correct for **automatic** compaction — don't summarize when already under budget, which is why automatic compaction works. But the manual `/compact` path (`forceEvaluate` / `forceEvaluateAll`) passes `force: true`, and `force` only bypassed the `config.enabled` check — NOT this threshold gate. So on a session at/below threshold:

1. `handleCompact` → `cap.forceEvaluate()`
2. `maybeCompact` computes usage, sees `<= softThreshold`, and `break`s immediately — zero turns compacted
3. `handleCompact` then unconditionally printed "Compacted oldest non-summary turns"

The existing `/compact` tests passed because they set `softThresholdPercent: 5` with huge turns that pushed usage **above** the threshold, so the gate never fired in the test.

## Decision

### `force` must skip the soft-threshold gate

In the convergence loop, gate the early exit on not-forced:

```ts
if (!input.options.force && metrics.usagePercent <= softThreshold) {
  break;
}
```

- `force: true` (manual `/compact`, `/compact --all`) → skips the gate and proceeds to slice-and-summarize regardless of current usage, so the manual command actually compacts.
- Automatic (non-force) → gate unchanged; compaction still won't run when already under budget.

### Regression test

Added to `drone-agent/test/compaction.test.ts` (in the `/compact slash command` block): a below-threshold session (`softThresholdPercent: 99` + large context window) must call `provider.chat()` and produce at least one summary turn. Verified this test **fails** without the fix and **passes** with it — proving it reproduces the bug (the earlier tests only used above-threshold sessions, so they gave false confidence).

## Key Points

- A "force" flag must audit every early-return/gate in the callee, not just the check it was originally named for (`config.enabled`). Here `force` needed to also bypass the convergence-loop threshold gate.
- Automatic compaction behavior is unchanged (`!input.options.force` guard preserves it).
- `/compact --all` (`forceEvaluateAll`) benefits too — same latent issue when usage is below threshold.
- The "Compacted…" success message is still printed unconditionally; making it reflect actual turns dropped is a separate hardening, out of scope here.

## Related

- [[concepts/session-management]] — Turn model + compaction triggering
- [[modules/drone-agent-plugins]] — compaction plugin row
- [[decisions/135-compaction-slash-command]] — The `/compact` command + CompactionCapability
- [[decisions/134-compaction-correctness-fix]] — Convergence loop + sliceSize
- [[decisions/144-compaction-fragment-integration]] — Prior compaction fixes

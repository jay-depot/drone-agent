---
key: compaction-mid-chain-fix
tags:
  []
created: 2026-06-23T22:23:37.399Z
updated: 2026-06-23T22:23:37.399Z
---

## Compaction Doesn't Fire Mid-Tool-Call-Chain — Fix Plan

### Root Cause
In conversation-service.ts, `onAfterToolCall` fires BEFORE tool results are appended to the session. Compaction sees stale (underestimated) usage and doesn't trigger. By the next iteration, ensureSafeBudget hard-drops turns.

### Steps
1. Swap order: move tool result appending before `runHooks('onAfterToolCall')` in conversation-service.ts
2. Update the comment to explain why tool results are appended before hooks
3. Fix `maybeCompact` early-return bug: `if (turns.length === 0) return;` doesn't reset `compactionInFlight`
4. Add test: compaction fires during multi-round tool-call loop when context grows past threshold
5. Add test: `compactionInFlight` flag is correctly reset on early return
6. Run existing tests to confirm nothing breaks
7. Update AGENTS.md with the ordering guarantee
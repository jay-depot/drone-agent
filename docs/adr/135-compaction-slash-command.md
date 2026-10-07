---
tags: [decision, feature, compaction, slash-command, plugin]
related: [concepts/session-management.md, modules/drone-agent-plugins.md, decisions/053-compaction-latch-fix.md, decisions/125-compaction-summary-eviction.md, decisions/133-compaction-oldest-turns-helper-consolidation.md, decisions/134-compaction-correctness-fix.md]
---

# 135. Compaction Slash Command + Extended CompactionCapability

**Summary**: Added a `/compact` slash command and extended the compaction plugin's `CompactionCapability` with `forceEvaluateAll`, `getStatus`, `dropSummary`, `dropAllSummaries`, and `dropOldestSummaries`. The command gives the user manual control over context compaction: force-compact, view summary status, and drop summary turns.

## Context

Compaction previously ran entirely automatically via plugin hooks (`onBeforePrompt` / `onAfterToolCall`). There was no way for the user to:

- Manually trigger compaction on demand
- See what summaries exist in the current context
- Drop a summary turn (e.g., one that's stale or no longer relevant)

The plugin already offered a `forceEvaluate()` capability, but it was only callable programmatically (e.g., by other plugins), not from the interactive session.

## Decision

### 1. Extend `CompactionCapability`

Added five new methods to the capability type:

```typescript
type CompactionCapability = {
  forceEvaluate: () => Promise<void>;
  forceEvaluateAll: () => Promise<void>;        // for --all
  getStatus: () => Promise<CompactionStatus>;   // for show + dry-run info
  dropSummary: (id: string) => Promise<boolean>; // for drop <id>
  dropAllSummaries: () => Promise<number>;       // for drop all
  dropOldestSummaries: (count: number) => Promise<number>; // for drop N
};
```

Also added a public `CompactionStatus` type describing the current compaction state (enabled, config, turn counts, context-window usage, summary list).

**Why extend the capability (not call internals directly):**
- Keeps the plugin's internal `compactionInFlight` latch respected
- Reuses `maybeCompact` logic (config checks, LLM calls, event emission)
- Slash command stays thin — just UI + capability calls
- `forceEvaluateAll` reuses `maybeCompact` with a temporary `slicePercent: 100` override

### 2. Register `/compact` slash command

```
/compact                    # compact half non-summary turns (if over minTurnsToCompact)
/compact --all             # compact ALL non-summary turns
/compact show              # list all summary turns in context
/compact drop <id|all|N>   # manually drop summary turn(s)
```

### 3. Decisions made

1. **Manual invoke when `enabled: false`** — **YES**, user intent overrides config. Both `forceEvaluate` and `forceEvaluateAll` temporarily set `config.enabled = true` during manual invocation (restoring it in `finally`), since `maybeCompact` checks `config.enabled` internally.
2. **`drop N` semantics** — **drop oldest N** (least relevant, prepended at head of turn array).
3. **`drop all` confirmation** — **no confirmation required** (simpler, `--force` flag not needed).
4. **Help text** — engine auto-prints help on unrecognized subcommand via `printHelp: true`.

## Consequences

- Users can now manually trigger compaction, inspect summary state, and drop stale summaries from the interactive session.
- The `--all` mode compacts ALL non-summary turns in a single call (bounded by `MAX_COMPACTION_ITERATIONS=5` and `summaryBudgetPercent` self-purge).
- Manual invocation works even when `compaction.enabled=false` (user intent overrides config).
- The `compactionInFlight` latch prevents races between manual and automatic compaction.

## Tests

Added 20 new tests to `drone-agent/test/compaction.test.ts`:
- `forceEvaluateAll` compacts all non-summary turns in one call
- `getStatus` returns correct counts and summary previews
- `dropSummary` / `dropAllSummaries` / `dropOldestSummaries` mutate session correctly
- Slash command routing for all subcommands
- `--all` respects `minTurnsToCompact` gate
- Warns but still compacts when `enabled: false` (Decision #1: user intent overrides config)

## Implementation

- **Commits**: `cc7c22c` ("feat(compaction): add /compact slash command and extended CompactionCapability"), `9c4ef3b` (chore checkpoint)
- **Files**: `drone-agent/src/plugins/compaction/index.ts`, `drone-agent/src/plugins/index.ts`, `drone-agent/test/compaction.test.ts`
- **Validation**: LSP zero errors; `pnpm -r run build` clean; `pnpm lint` clean; `pnpm test` 1933 passed / 9 skipped.

## Related

- session-management — Context budgeting, safety trim, and compaction
- [drone-agent-plugins](../../drone-agent/src/plugins/) — The `compaction` plugin row
- [053-compaction-latch-fix](053-compaction-latch-fix.md) — Prior compaction latch fix
- [125-compaction-summary-eviction](125-compaction-summary-eviction.md) — Prior compaction summary eviction fix
- [133-compaction-oldest-turns-helper-consolidation](133-compaction-oldest-turns-helper-consolidation.md) — Prior oldest-turns fix + helper consolidation
- [134-compaction-correctness-fix](134-compaction-correctness-fix.md) — The correctness fix this slash command builds on

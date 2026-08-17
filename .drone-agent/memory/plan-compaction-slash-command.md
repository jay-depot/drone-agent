---
key: plan-compaction-slash-command
tags:
  - plan
  - compaction
  - slash-command
  - plugin
created: 2026-08-17T03:23:02.094Z
updated: 2026-08-17T03:23:02.094Z
---

# Compaction Slash Command Plan

## Command Structure
```
/compact                    # compact half non-summary turns (if over minTurnsToCompact)
/compact --all             # compact ALL non-summary turns
/compact show              # list all summary turns in context
/compact drop <id|all|N>   # manually drop summary turn(s)
```

## Design Overview

### 1. Integration Point: Extended `CompactionCapability`

The plugin already offers `forceEvaluate()` — extend it to support new modes:

```typescript
// In compaction/index.ts — extend the capability type
type CompactionCapability = {
  forceEvaluate: () => Promise<void>;
  // NEW:
  forceEvaluateAll: () => Promise<void>;        // for --all
  getStatus: () => CompactionStatus;             // for show + dry-run info
  dropSummary: (id: string) => Promise<boolean>; // for drop <id>
  dropAllSummaries: () => Promise<number>;       // for drop all
  dropOldestSummaries: (count: number) => Promise<number>; // for drop N
};

type CompactionStatus = {
  enabled: boolean;
  config: DroneCompactionConfig;  // current effective config
  turns: {
    total: number;
    nonSummary: number;
    summary: number;
    oldestNonSummaryIndex: number | null;  // index of oldest non-summary turn
  };
  contextWindow: {
    softThresholdPercent: number;
    currentUsagePercent: number;
    summaryBudgetPercent: number;
    currentSummaryPercent: number;
  };
  summaries: Array<{ id: string; preview: string; tokenCount: number }>; // for `show`
};
```

**Why extend the capability (not call internals directly):**
- Keeps the plugin's internal `compactionInFlight` latch respected
- Reuses `maybeCompact` logic (config checks, LLM calls, event emission)
- Slash command stays thin — just UI + capability calls
- `forceEvaluateAll` can reuse `maybeCompact` with a temporary `slicePercent: 100` override

---

### 2. Slash Command Handler Sketch

```typescript
// In compaction/index.ts, inside register():
registration.registerSlashCommand({
  command: 'compact',
  description: 'Manage context compaction',
  handler: async (ctx) => {
    const cap = ctx.engine.getCapability<CompactionCapability>('compaction');
    if (!cap) return { exit: false, clearSession: false, printHelp: false };

    const args = ctx.args.trim().split(/\s+/);
    const sub = args[0]?.toLowerCase();

    switch (sub) {
      case 'show':
        return handleShow(cap, ctx);
      case 'drop':
        return handleDrop(cap, ctx, args.slice(1));
      case '':
      case undefined:
        return handleCompact(cap, ctx, { all: ctx.args.includes('--all') });
      default:
        ctx.logger.warn(`Unknown compact subcommand: ${sub}`);
        return { exit: false, clearSession: false, printHelp: true };
    }
  },
});
```

---

### 3. Subcommand Implementations

#### `handleCompact` (no args / `--all`)
```typescript
async function handleCompact(cap, ctx, { all }) {
  const status = cap.getStatus();
  
  if (!status.enabled) {
    ctx.logger.warn('Compaction is disabled in config');
    return { exit: false, clearSession: false, printHelp: false };
  }

  if (status.turns.nonSummary < status.config.minTurnsToCompact) {
    ctx.logger.warn(
      `Only ${status.turns.nonSummary} non-summary turn(s); need at least ${status.config.minTurnsToCompact} to compact`
    );
    return { exit: false, clearSession: false, printHelp: false };
  }

  if (all) {
    await cap.forceEvaluateAll();
    ctx.logger.info('Compacted ALL non-summary turns');
  } else {
    await cap.forceEvaluate();  // existing: compacts slicePercent (default 25%)
    ctx.logger.info('Compacted oldest non-summary turns');
  }
  return { exit: false, clearSession: false, printHelp: false };
}
```

#### `handleShow`
```typescript
function handleShow(cap, ctx) {
  const status = cap.getStatus();
  if (status.summaries.length === 0) {
    ctx.logger.info('No compaction summaries in current context');
    return { exit: false, clearSession: false, printHelp: false };
  }
  
  ctx.logger.info('Compaction summaries (newest first):');
  for (const s of status.summaries) {
    ctx.logger.info(`  ${s.id.slice(0,8)}  ${s.tokenCount} tokens  ${s.preview}`);
  }
  ctx.logger.info(`Total: ${status.summaries.length} summary turn(s), ${status.contextWindow.currentSummaryPercent}% of budget`);
  return { exit: false, clearSession: false, printHelp: false };
}
```

#### `handleDrop`
```typescript
async function handleDrop(cap, ctx, args) {
  if (args.length === 0) {
    ctx.logger.warn('Usage: /compact drop <id|all|N>');
    return { exit: false, clearSession: false, printHelp: true };
  }
  
  const target = args[0].toLowerCase();
  let dropped = 0;
  
  if (target === 'all') {
    dropped = await cap.dropAllSummaries();
    ctx.logger.info(`Dropped ${dropped} summary turn(s)`);
  } else if (/^\d+$/.test(target)) {
    dropped = await cap.dropOldestSummaries(parseInt(target, 10));
    ctx.logger.info(`Dropped ${dropped} oldest summary turn(s)`);
  } else {
    const ok = await cap.dropSummary(target);
    if (ok) ctx.logger.info(`Dropped summary ${target}`);
    else ctx.logger.warn(`Summary not found: ${target}`);
  }
  return { exit: false, clearSession: false, printHelp: false };
}
```

---

### 4. Capability Implementation Additions

Inside `createCompactionPlugin`, after the existing `forceEvaluate`:

```typescript
const capability: CompactionCapability = {
  forceEvaluate: async () => { /* existing */ },
  
  forceEvaluateAll: async () => {
    // Temporarily override slicePercent to 100 for one shot
    const originalSlice = context.config.slicePercent;
    context.config.slicePercent = 100;
    try {
      await runCompaction(context, systemPrompt);
    } finally {
      context.config.slicePercent = originalSlice;
    }
  },
  
  getStatus: () => {
    const turns = sessionManager.getTurns();
    const summaryTurns = turns.filter(t => t.kind === 'summary');
    const nonSummaryTurns = turns.filter(t => t.kind !== 'summary');
    const counts = summarizeTokenCounts(turns, systemPrompt, config, provider);
    
    return {
      enabled: config.enabled,
      config,
      turns: {
        total: turns.length,
        nonSummary: nonSummaryTurns.length,
        summary: summaryTurns.length,
        oldestNonSummaryIndex: nonSummaryTurns[0] ? turns.indexOf(nonSummaryTurns[0]) : null,
      },
      contextWindow: {
        softThresholdPercent: config.softThresholdPercent,
        currentUsagePercent: counts.usagePercent,
        summaryBudgetPercent: config.summaryBudgetPercent,
        currentSummaryPercent: counts.summaryPercent,
      },
      summaries: summaryTurns.map(t => ({
        id: t.id,
        preview: t.messages[0]?.content?.slice(0, 80) ?? '',
        tokenCount: estimateTurnTokens(t, provider),
      })),
    };
  },
  
  dropSummary: async (id) => sessionManager.dropSummaryTurnById(id) !== null,
  
  dropAllSummaries: async () => {
    const ids = sessionManager.getSummaryTurns().map(t => t.id);
    return ids.length > 0 ? sessionManager.dropTurnsByIds(ids) : 0;
  },
  
  dropOldestSummaries: async (count) => {
    const ids = sessionManager.getSummaryTurns()
      .slice(-count)  // oldest are at end (prepended at head)
      .map(t => t.id);
    return ids.length > 0 ? sessionManager.dropTurnsByIds(ids) : 0;
  },
};
```

---

### 5. Config Considerations

| Scenario | Behavior |
|----------|----------|
| `enabled: false` | Slash command warns but **still allows manual invocation** (user intent overrides config) |
| `--all` with huge context | Still bounded by `MAX_COMPACTION_ITERATIONS=5` and `summaryBudgetPercent` self-purge |
| `drop` during active compaction | `compactionInFlight` latch prevents races — drop waits or fails fast |

---

### 6. Testing Strategy

Add to `test/compaction.test.ts`:
- `forceEvaluateAll` compacts all non-summary turns in one call
- `getStatus` returns correct counts + summary previews
- `dropSummary` / `dropAllSummaries` / `dropOldestSummaries` mutate session correctly
- Slash command handler routes correctly and logs expected messages
- `--all` respects `minTurnsToCompact` gate (should still require minimum)

---

### 7. Files to Modify

| File | Changes |
|------|---------|
| `drone-agent/src/plugins/compaction/index.ts` | Extend `CompactionCapability`, add `getStatus`/`drop*`/`forceEvaluateAll`, register slash command |
| `drone-agent/src/plugins/index.ts` | Re-export updated `CompactionCapability` type |
| `drone-agent/test/compaction.test.ts` | New tests for capability extensions + slash command |

---

### 8. Decisions Made

1. **Manual invoke when `enabled: false`** — **YES**, user intent overrides config
2. **`drop N` semantics** — **drop oldest N** (least relevant, prepended at head of turn array)
3. **`drop all` confirmation** — **no confirmation required** (simpler, `--force` flag not needed)
4. **Help text** — engine auto-prints help on unrecognized subcommand via `printHelp: true`

---

### Validation Criteria

- [ ] LSP passes (`pnpm -r run typecheck`)
- [ ] Build passes (`pnpm -r run build`)
- [ ] Lint passes (`pnpm -r run lint`)
- [ ] Fast tests pass (`pnpm -r run test`)
- [ ] New tests cover: capability extensions, slash command routing, drop operations, status reporting
- [ ] Manual testing: `/compact`, `/compact --all`, `/compact show`, `/compact drop <id>`, `/compact drop all`, `/compact drop N`
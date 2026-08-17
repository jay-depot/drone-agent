---
key: plan-compaction-refactor
tags:
  - compaction
  - plan
  - architecture
  - bugfix
created: 2026-08-17T23:25:36.441Z
updated: 2026-08-17T23:57:03.420Z
---

# Implementation Plan: Compaction Plugin Bug Fixes & Fragment Integration

## Summary
Fix critical string-escaping bugs, restore a lost parameter, integrate prompt fragments for consistent token counting, restore removed documentation, and fix minor issues — all in the compaction plugin on the `fix/compaction-turn-ordering` branch.

---

## Step 1: Fix escaped newline strings (Blocker)

**File:** `drone-agent/src/plugins/compaction/index.ts`

Every `\\n` that was a `\n` in the original code must be reverted. These are JavaScript string literals, not raw strings — `\\n` is a literal backslash followed by `n`, not a newline.

**Specific changes:**
- Line 25: `'Conversation summary (compacted):\\\\n'` → `'Conversation summary (compacted):\n'`
- Line 67: `.join('\\\\n')` → `.join('\n')` (inside `formatTurnsForSummary`, tool calls join)
- Line 68: `` `${header} ${body}\\\\n${toolSummary}` `` → `` `${header} ${body}\n${toolSummary}` ``
- Line 73: `` `--- Turn ${index + 1} ---\\\\n${parts.join('\\\\n')}` `` → `` `--- Turn ${startIndex + index + 1} ---\n${parts.join('\n')}` `` (also restoring `startIndex`)
- Line 75: `.join('\\\\n')` → `.join('\n')` (the outer `.join()` in `formatTurnsForSummary`)
- Lines 162–170: The summary system prompt — revert all `\\\\n` back to `\n` in the multi-line string concatenation:
  ```
  'order from most to least important:\n' +
  '1. User input, instruction, questions, and decisions. Preserve these ' +
  'verbatim.\n' +
  "2. Any context needed to understand the user's input, instructions, " +
  'questions, and decisions. For instance, if the user says "Yes, like that," ' +
  'whatever "that" refers to needs to be included in the summary, if ' +
  'it is available.\n' +
  '3. Architectural or design information.\n' +
  '4. Any other relevant information.\n\n' +
  'Detailed tool calls and results should be discarded. Provide a summary ' +
  'of what was done if it is relevant and only if space allows.\n\n' +
  ```
- Line 255: `` `${config.summaryMaxTokens} tokens:\\\\n\\\\n${transcript}` `` → `` `${config.summaryMaxTokens} tokens:\n\n${transcript}` ``

**Agent:** code

---

## Step 2: Fix the broken regex in `handleDrop`

**File:** `drone-agent/src/plugins/compaction/index.ts`

Change `/^\\\\d+$/` back to `/^\d+$/` on the line matching numeric drop targets.

```typescript
// BROKEN:
} else if (/^\\d+$/.test(target)) {
// CORRECT:
} else if (/^\d+$/.test(target)) {
```

**Agent:** code

---

## Step 3: Restore `startIndex` parameter to `formatTurnsForSummary`

**File:** `drone-agent/src/plugins/compaction/index.ts`

The original function had `startIndex` to preserve temporal turn numbering in summaries. Restore it:

```typescript
function formatTurnsForSummary(
  turns: DroneSessionTurn[],
  startIndex = 0
): string {
  return turns
    .map((turn, index) => {
      const parts = turn.messages.map(message => {
        // ... same body ...
      });
      return `--- Turn ${startIndex + index + 1} ---\n${parts.join('\n')}`;
    })
    .join('\n');
}
```

And update the call site in `maybeCompact` to pass the correct starting index. The call currently is:
```typescript
const slice = getOldestNonSummaryTurns(turns, sliceSize);
const transcript = formatTurnsForSummary(slice);
```

It should pass the index of the first turn in `slice` relative to all non-summary turns, so the LLM sees "Turn 5" instead of "Turn 1" when compacting the 5th–8th turns. To compute this, find the index of `slice[0]` among the non-summary turns:

```typescript
const allNonSummary = turns.filter(t => t.kind !== 'summary');
const sliceStartIndex = allNonSummary.indexOf(slice[0]);
const transcript = formatTurnsForSummary(slice, sliceStartIndex);
```

Or more simply, since `getOldestNonSummaryTurns` returns them in order, the starting index is the number of non-summary turns before the slice:
```typescript
const nonSummaryCount = turns.filter(t => t.kind !== 'summary').length;
const sliceStartIndex = nonSummaryCount - slice.length; // wait, this is wrong for non-from-end slices
```

Actually, since `getOldestNonSummaryTurns` iterates from the beginning, `slice[0]` is the first non-summary turn, and the starting index is always 0 for "oldest N" turns. But wait — the original code used `nonSummaryTurns.length - slice.length` as the startIndex, which would mean the turns are numbered from their position at the tail. Let me re-examine...

Actually, looking at the original committed code on main:
```typescript
const transcript = formatTurnsForSummary(
  slice,
  nonSummaryTurns.length - slice.length
);
```

This was because the old code used `nonSummaryTurns.slice(-sliceSizeCapped)` to take from the END of the non-summary array (which was the "oldest" turns in the old, wrong ordering). With `getOldestNonSummaryTurns`, the slice always starts from the beginning, so `startIndex` should be 0 — unless the slice doesn't start from the very first non-summary turn.

Wait — after one round of compaction, some non-summary turns at the beginning have been summarized away, but the turns that remain start from a later position in the conversation. The turn numbering should reflect the position within the *remaining* non-summary turns, or ideally within the full conversation. Since we no longer have the original positions after turns are dropped, `startIndex = 0` is the safest correct default. The key point is that the `startIndex` parameter exists so the caller CAN provide context if they have it.

**Final decision:** Restore the `startIndex` parameter with default value 0. Don't pass a computed index for now — default 0 is correct for "oldest non-summary turns" since they start from the beginning of the remaining turns.

**Agent:** code

---

## Step 4: Integrate prompt fragments into `runCompaction` and `getStatus`

**File:** `drone-agent/src/plugins/compaction/index.ts`

Add a `buildFragmentMessages` callback to `CompactionPluginDeps`:

```typescript
export type CompactionPluginDeps = {
  sessionManager: DroneSessionManager;
  getModel: () => string;
  getProvider: () => DroneLlmProvider;
  /**
   * Optional callback to emit conversation events for TUI visibility.
   * When provided, compaction will emit 'started', 'completed', and
   * 'failed' events so the TUI can show compaction progress in the
   * tail region and commit entries to scrollback.
   */
  emitEvent?: (event: DroneConversationEvent) => void;
  /**
   * Build the list of system messages from registered prompt fragments.
   * Used to account for fragment tokens in context-window calculations.
   * Returns an empty array if no fragments are registered (e.g. during tests).
   */
  buildFragmentMessages: () => Promise<DroneChatMessage[]>;
};
```

**Update `runCompaction`:** Replace `fragmentMessages: []` with the result of `deps.buildFragmentMessages()`:

```typescript
async function runCompaction(
  context: RegistrationContext,
  systemPrompt: string,
  options: CompactionOptions = {}
): Promise<void> {
  const baseSystemMessages: DroneChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];
  const fragmentMessages = await context.buildFragmentMessages();
  await maybeCompact({
    context,
    baseSystemMessages,
    fragmentMessages,
    options,
  });
}
```

But `runCompaction` doesn't currently have access to `deps`. It receives `context: RegistrationContext`. So add `buildFragmentMessages` to `RegistrationContext`:

```typescript
type RegistrationContext = {
  config: DroneCompactionConfig;
  getProvider: () => DroneLlmProvider;
  getModel: () => string;
  sessionManager: DroneSessionManager;
  logger: DroneLogger;
  compactionInFlight: { value: boolean };
  emitEvent?: (event: DroneConversationEvent) => void;
  buildFragmentMessages: () => Promise<DroneChatMessage[]>;
};
```

Wire it in `createCompactionPlugin`:
```typescript
const context: RegistrationContext = {
  // ... existing fields ...
  buildFragmentMessages: deps.buildFragmentMessages,
};
```

**Update `getStatus`:** Replace the inline fallback calculation with `calculateFallbackContextWindow` using actual fragment messages:

```typescript
getStatus: async () => {
  const turns = sessionManager.getTurns();
  // ...
  const baseSystemMessages: DroneChatMessage[] = [
    { role: 'system', content: registration.getConfig().systemPrompt },
  ];
  const fragmentMessages = await context.buildFragmentMessages();
  const fallbackContextWindow = calculateFallbackContextWindow(
    baseSystemMessages,
    fragmentMessages,
    config.softThresholdPercent
  );
  // ...
  const counts = summarizeTokenCounts({
    turns,
    baseSystemMessages,
    fragmentMessages,
    contextWindowTokens,
  });
  // ...
```

**File:** `drone-agent/src/index.tsx`

Wire the `buildFragmentMessages` dep:
```typescript
const builtInPlugins = createBuiltInPlugins({
  sessionManager,
  ...createLlmGetters(engineRef),
  buildFragmentMessages: async () => {
    const engine = getEngine();
    const fragments = await engine.renderPromptFragments();
    return fragments.map(content => ({ role: 'system' as const, content }));
  },
});
```

**File:** `drone-agent/test/compaction.test.ts`

Update `createCompactionPlugin` calls to provide `buildFragmentMessages`. For tests, use a no-op that returns `[]`:

```typescript
const plugin = createCompactionPlugin({
  sessionManager,
  getModel: () => 'fake',
  getProvider: () => provider,
  buildFragmentMessages: async () => [],
});
```

**Agent:** code

---

## Step 5: Fix help text typo

**File:** `drone-agent/src/plugins/compaction/index.ts`

Change:
```typescript
'Context Comp compaction: proactively summarizes ...'
```
To:
```typescript
'Context Compaction: proactively summarizes ...'
```

**Agent:** code

---

## Step 6: Restore JSDoc on `CompactionPluginDeps.emitEvent`

**File:** `drone-agent/src/plugins/compaction/index.ts`

Put back the doc comment that was removed:

```typescript
export type CompactionPluginDeps = {
  sessionManager: DroneSessionManager;
  getModel: () => string;
  getProvider: () => DroneLlmProvider;
  /**
   * Optional callback to emit conversation events for TUI visibility.
   * When provided, compaction will emit 'started', 'completed', and
   * 'failed' events so the TUI can show compaction progress in the
   * tail region and commit entries to scrollback.
   */
  emitEvent?: (event: DroneConversationEvent) => void;
  /**
   * Build the list of system messages from registered prompt fragments.
   * Used to account for fragment tokens in context-window calculations.
   * Returns an empty array if no fragments are registered (e.g. during tests).
   */
  buildFragmentMessages: () => Promise<DroneChatMessage[]>;
};
```

**Agent:** code

---

## Step 7: Restore algorithm-explaining comments

**File:** `drone-agent/src/plugins/compaction/index.ts`

Restore the useful comments that explain *what* each branch in the convergence loop is for. Keep the concise style (no "step" comments), but restore the branch labels:

```typescript
// Convergence loop: keep compacting until usage is below the soft threshold
// or no more progress can be made.
const MAX_COMPACTION_ITERATIONS = 5;
for (let iteration = 0; iteration < MAX_COMPACTION_ITERATIONS; iteration++) {
  // ...
  if (metrics.summaryPercent > summaryBudget) {
    // Self-purge: drop oldest summary until the summary region is under budget.
    // ...
  }

  // Slice-and-summarize: usage above threshold and enough turns to compact.
  const nonSummaryCount = ...;
  if (nonSummaryCount < config.minTurnsToCompact) {
    break; // not enough non-summary turns to compact
  }

  // ...
  if (sliceSize <= 0) {
    break;
  }

  // ...

  try {
    // ...
  } catch (error) {
    // ...
    break; // a failed summary means no progress this round; stop
  }
}
```

Also restore the comment about summary prepend/tail ordering that was removed:
```typescript
// Summaries are prepended at the head; normal turns are appended at the
// tail. getOldestNonSummaryTurns iterates forward, skipping summaries, to
// collect exactly these turns.
const slice = getOldestNonSummaryTurns(turns, sliceSize);
```

Remove any "step"-style comments that just restate the code (the ones the plan already removed correctly, like `// continue` after a `continue` statement).

**Agent:** code

---

## Step 8: Fix `handleDrop` type safety

**File:** `drone-agent/src/plugins/compaction/index.ts`

The `dropped` variable is used for both `number` and `boolean` return types. Use separate variables or explicit union type:

```typescript
async function handleDrop(
  cap: CompactionCapability,
  ctx: DroneSlashCommandContext,
  args: string[]
): Promise<boolean> {
  if (args.length === 0) {
    ctx.logger.warn('Usage: /compact drop <id|all|N>');
    return true;
  }

  const target = args[0].toLowerCase();

  if (target === 'all') {
    const dropped = await cap.dropAllSummaries();
    ctx.logger.info(`Dropped ${dropped} summary turn(s)`);
  } else if (/^\d+$/.test(target)) {
    const dropped = await cap.dropOldestSummaries(parseInt(target, 10));
    ctx.logger.info(`Dropped ${dropped} oldest summary turn(s)`);
  } else {
    const ok = await cap.dropSummary(target);
    if (ok) {
      ctx.logger.info(`Dropped summary ${target}`);
    } else {
      ctx.logger.warn(`Summary not found: ${target}`);
    }
  }
  return true;
}
```

**Agent:** code

---

## Step 9: Update tests for `buildFragmentMessages` dep

**File:** `drone-agent/test/compaction.test.ts`

Every `createCompactionPlugin({...})` call in the test file needs `buildFragmentMessages: async () => []` added. Find all call sites and add it.

**Agent:** code

---

## Step 10: Run validation

1. `pnpm -r run build` — must pass
2. `pnpm -r run lint` — must pass (prettier will reformat)
3. `pnpm -r run test` — all compaction tests must pass
4. LSP diagnostics on `drone-agent/src/plugins/compaction/index.ts` — zero errors
5. Re-read all edited files after linting (prettier will reformat them)

**Agent:** code

---

## Validation Criteria

- [ ] All `\n` strings are correct newlines (no `\\n` in string literals that should be `\n`)
- [ ] `/^\d+$/` regex is correct (not `/^\\d+$/`)
- [ ] `formatTurnsForSummary` has `startIndex` parameter with default 0
- [ ] `getStatus` uses `calculateFallbackContextWindow` with actual fragment messages
- [ ] `runCompaction` uses `context.buildFragmentMessages()` instead of `fragmentMessages: []`
- [ ] `CompactionPluginDeps` has `buildFragmentMessages` with JSDoc
- [ ] `CompactionPluginDeps.emitEvent` has its JSDoc restored
- [ ] Help text reads "Context Compaction" (not "Context Comp")
- [ ] Algorithm-explaining comments restored in convergence loop
- [ ] `handleDrop` uses separate variables for number vs boolean returns
- [ ] Test file updated with `buildFragmentMessages: async () => []`
- [ ] `pnpm -r run build` passes
- [ ] `pnpm -r run lint` passes
- [ ] `pnpm -r run test` passes (compaction tests)
- [ ] Zero LSP diagnostics on the compaction plugin file
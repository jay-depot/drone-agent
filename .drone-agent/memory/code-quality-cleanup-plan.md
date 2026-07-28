---
key: code-quality-cleanup-plan
tags:
  - plan
  - code-quality
created: 2026-07-28T19:52:30.343Z
updated: 2026-07-28T19:52:30.343Z
---

# Code Quality Cleanup Plan

## Summary
Address 22 code quality issues identified during a comprehensive codebase review of drone-agent. Issues span logic bugs, dead code, duplication, and style/readability problems.

## Plan A — Main Cleanup (this session)

### Step 1: Fix Logic Bugs
**Assignee:** code

#### 1a: Stale tool list in `sendUserMessage` loop
- **File:** `drone-agent/src/runtime/conversation-service.ts`
- **Change:** Move `const tools = getLlmTools();` from outside the `while(true)` loop (currently ~line 130) to inside the loop body, right after the cancel check and before `ensureSafeBudget(systemMessages, tools)`.
- **Rationale:** Tools can change dynamically (MCP mount/unmount, persona switches). Re-fetching each iteration ensures the LLM always sees the current tool set and budget calculations use fresh data.
- **Validation:** Verify that `sendUserMessage` still works end-to-end. Check that MCP mount/unmount during a conversation is reflected in subsequent iterations.

#### 1b: `toolCall` handler uses wrong field in plain output handler
- **File:** `drone-agent/src/output-handlers.ts`, line ~44
- **Change:** In the `case 'toolCall':` branch, change `event.content` to `event.arguments`:
  ```typescript
  output.write(`\x1b[33m⚡ ${event.name}(${JSON.stringify(event.arguments ?? {})})\x1b[0m\n`);
  ```
- **Rationale:** The `DroneConversationEvent` discriminated union has `toolCall` with `name` and `arguments` fields, not `content`. The current code always renders `undefined`.
- **Validation:** This code path is currently dead (conversation service emits `toolCallBatch`, not individual `toolCall`), but fix it for correctness.

### Step 2: Remove Dead Code
**Assignee:** code

Remove all unused exports and types in one batch:

#### 2a: Dead functions in `diff-renderer.ts`
- **File:** `drone-agent/src/shared/diff-renderer.ts`
- **Remove:** `supportsColor()` function, `stripAnsi()` function, `renderDiff()` function, `renderHunk()` function, `DiffHunk` interface
- **Keep:** `renderDiffV2()`, `renderHunkV2()`, `DiffHunkV2`, `DiffResult`, `DiffSummary`, `FuzzLevel`, `countChanges()`

#### 2b: Dead type guard in `type-guards.ts`
- **File:** `drone-agent/src/shared/type-guards.ts`
- **Remove:** `isStringArray()` function

#### 2c: Dead output handlers
- **File:** `drone-agent/src/output-handlers.ts`
- **Remove:** `makeJsonOutputEventHandler()` function, `writeNdjsonEvent()` function
- **Keep:** `makePlainOutputEventHandler()`, `makeNdjsonOutputEventHandler()`, `OutputEvent` type

#### 2d: Dead types in `session-types.ts`
- **File:** `drone-core/src/session-types.ts`
- **Remove:** `DroneSessionState` type
- **Check:** Remove its export from `drone-core/src/index.ts`

#### 2e: Dead type in `config-types.ts`
- **File:** `drone-core/src/config-types.ts`
- **Remove:** `DroneSessionPhase` type
- **Check:** Remove its export from `drone-core/src/index.ts`

#### 2f: Dead types in `plugin-system.ts`
- **File:** `drone-core/src/plugin-system.ts`
- **Remove:** `DroneMacroStep` type, `DroneMacroDefinition` type
- **Check:** Remove their exports from `drone-core/src/index.ts`
- **Note:** The macros plugin (`plugins/macros/index.ts`) defines its own types — those are the live ones.

### Step 3: Consolidate Duplicated Code
**Assignee:** code

#### 3a: Extract `insertWriterSorted`/`insertProviderSorted` to shared utility
- **Files:** `drone-agent/src/plugins/skills/index.ts`, `drone-agent/src/plugins/persona/index.ts`
- **Change:** Extract the identical `insertProviderSorted`, `removeProvider`, `insertWriterSorted`, and `removeWriter` functions into a shared utility file, e.g. `drone-core/src/sorted-registry.ts`.
- **New file:** `drone-core/src/sorted-registry.ts`
  ```typescript
  export function insertSortedByPrecedence<T extends { id: string; precedence: number }>(
    items: T[],
    item: T
  ): void {
    const idx = items.findIndex(p => p.precedence > item.precedence);
    if (idx === -1) { items.push(item); }
    else { items.splice(idx, 0, item); }
  }

  export function removeById<T extends { id: string }>(
    items: T[],
    id: string
  ): void {
    const idx = items.findIndex(p => p.id === id);
    if (idx !== -1) { items.splice(idx, 1); }
  }

  const SCOPE_ORDER: Record<string, number> = {
    project: 0, user: 1, beacon: 2, coordinator: 3,
  };

  export function insertWriterSorted<T extends { id: string; scope: string }>(
    items: T[],
    item: T
  ): void {
    const order = SCOPE_ORDER[item.scope] ?? 99;
    const idx = items.findIndex(w => (SCOPE_ORDER[w.scope] ?? 99) > order);
    if (idx === -1) { items.push(item); }
    else { items.splice(idx, 0, item); }
  }
  ```
- **Update:** Import and use these in both `skills/index.ts` and `persona/index.ts`, replacing the inline duplicates.
- **Export:** Add exports to `drone-core/src/index.ts`.

#### 3b: Extract `getProvider`/`getModel` closures in `index.tsx`
- **File:** `drone-agent/src/index.tsx`
- **Change:** Extract a helper function:
  ```typescript
  function createLlmGetters(engineRef: { current: DronePluginEngine | undefined }) {
    return {
      getProvider: () => {
        const llm = engineRef.current?.getCapability<DroneLlmCapability>('llm');
        if (!llm) throw new Error('LLM provider broker is not available.');
        return llm.getActiveProvider();
      },
      getModel: () => {
        const llm = engineRef.current?.getCapability<DroneLlmCapability>('llm');
        if (!llm) return model; // fallback
        return llm.getModel();
      },
    };
  }
  ```
- **Use:** Replace the duplicated inline closures in both `createContextBudgetService` and `createBuiltInPlugins` calls.

### Step 4: Style and Readability Cleanup
**Assignee:** code

#### 4a: `hasOwnProperty` → `in` operator
- **File:** `drone-agent/src/runtime/plugin-engine.ts`, line ~740
- **Change:** Replace `Object.prototype.hasOwnProperty.call(raw, 'kickMessage')` with `'kickMessage' in raw` (and same for `toolResult`).

#### 4b: String concatenation → template literals
- **Files:** `drone-agent/src/plugins/skills/index.ts`, `drone-agent/src/plugins/persona/index.ts`
- **Change:** Replace all `'string ' + var + ' more'` patterns with `` `string ${var} more` `` in logger calls and error messages.

#### 4c: Env var regex too restrictive
- **File:** `drone-core/src/config-schema.ts`
- **Change:** In `transformEnvVars`, change regex from `/\$\{([A-Z0-9_]+)\}/g` to `/\$\{([A-Za-z0-9_]+)\}/g` to support lowercase env var names.

#### 4d: Refactor TUI `useEffect` to use ref-based callbacks
- **File:** `drone-agent/src/tui/app.tsx`
- **Change:** The conversation event listener `useEffect` has too many dependencies causing re-subscription. Refactor to store callbacks in refs so the effect only depends on `opts.engine`:
  ```typescript
  const logRef = useRef(log);
  logRef.current = log;
  // ... same for appendEntry, addItem, etc.
  ```
  Then the effect body uses `logRef.current` etc. instead of the closure values, and the dependency array shrinks to `[opts.engine]`.

#### 4e: Merge two `useInput` hooks into one
- **File:** `drone-agent/src/tui/app.tsx`
- **Change:** Combine the global keybindings `useInput` (line ~350) and the elicitation `useInput` (line ~410) into a single `useInput` with a unified dispatch that checks `activeQuestion` first, then falls through to global bindings.

#### 4f: Remove redundant `buildSystemMessages()` call in compaction
- **File:** `drone-agent/src/plugins/compaction/index.ts`
- **Change:** In `runCompaction`, remove the call to `budgetService.buildSystemMessages()`. The function receives `systemPrompt` as a parameter — use it directly for `baseSystemMessages` and skip the fragment messages entirely (they're not needed for compaction's fallback calculation).

#### 4g: Extract shared CLI option defaults
- **File:** `drone-agent/src/cli.ts`
- **Change:** Extract the repeated `options: CliOptions = { ... }` initialization into a helper:
  ```typescript
  function createDefaultCliOptions(): CliOptions {
    return {
      once: false, outputPlain: false, outputJson: false,
      pluginOverrides: [], debugSubsystems: [],
    };
  }
  ```
  Use it in both `parseCliArgs` and `parseMigrateSubcommand`.

#### 4h: Simplify ID generation (remove `Date.now()` prefix)
- **Files:** `drone-agent/src/tui/hooks/useTailRegion.ts`, `drone-agent/src/tui/hooks/useChatLog.ts`
- **Change:** In `useTailRegion`, change `const id = \`tail-${Date.now()}-${idCounter.current}\`;` to `const id = \`tail-${++idCounter.current}\`;`. In `useChatLog`, change similarly.

### Step 5: Validation
**Assignee:** code

1. Run `pnpm -r run build` — must pass with zero errors
2. Run `pnpm -r run lint` — must pass with zero errors
3. Run `pnpm -r run test` — must pass
4. LSP diagnostics — must be clean
5. Verify no remaining references to removed exports/types (grep for each removed name)

---

## Plan B — Config Deep Merge (separate session)

### Summary
Replace the 450-line `applyAgentConfigLayer` function in `drone-core/src/config-types.ts` with a generic deep-merge utility that handles the common pattern (spread merge with nested object handling for specific keys like `models`, `servers`, `files`).

### Key Design Decisions
- Generic `deepMerge` function that recursively merges objects
- Special handling for array fields that should be replaced (not concatenated): `models`, `servers`, `files`
- Special handling for `enabledPlugins` (additive at project level)
- Each config section becomes a one-line merge call
- Must preserve the existing precedence semantics (last-write-wins per key)

### Validation
- Same as Plan A Step 5
- Additionally: verify that config merging produces identical results for all existing test cases and real config files

---

## Roadmap Item — Dynamic Mid-Panel Widget Registration

### Summary
The current mid-panel widget system in `tui/app.tsx` uses a hardcoded list of known plugin IDs (`['todo', 'focus']`) and a `useRef` that doesn't trigger re-renders. This should be rearchitected to:

1. Use `useState` instead of `useRef` for reactive updates
2. Replace the hardcoded `knownWidgetPluginIds` with a registration pattern where plugins call `registerMidPanelWidget` on the TUI capability
3. Allow user/external plugins to register mid-panel components
4. Support custom React components per widget (not just text lines)

This deserves its own dedicated planning session before implementation.
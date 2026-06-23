---
key: refactor-plan-v1
tags:
  - refactor
  - plan
  - typebox
  - tui
  - search
created: 2026-06-23T02:41:47.177Z
updated: 2026-06-23T02:44:56.720Z
---

# Refactor Plan: 3 High-Impact Refactors + Honorable Mentions

## Overview

This plan covers three major refactors and two smaller honorable-mention fixes for the drone-agent codebase. Each refactor is broken into atomic, testable steps with clear dependencies.

---

## Refactor 1: Replace hand-rolled config validation with @sinclair/typebox

**Goal:** Eliminate ~700 lines of repetitive validation boilerplate in `drone-agent/src/runtime/config.ts` by using `@sinclair/typebox` for declarative, type-safe config schema validation.

**Why TypeBox:** Zero dependencies, generates JSON Schema (useful for tool schemas too), infers TypeScript types from schemas, handles complex unions (tcp vs stdio transport) naturally.

**Location:** `drone-core/` (schema definitions) and `drone-agent/src/runtime/config.ts` (parser replacement)

### Steps

#### Step 1.1: Add @sinclair/typebox dependency to drone-core
- **Action:** `pnpm add @sinclair/typebox` in `drone-core/`
- **Verification:** `pnpm build` succeeds, typebox is importable

#### Step 1.2: Define TypeBox schema for PartialDroneAgentConfig in drone-core
- **Action:** Create `drone-core/src/config-schema.ts`
- **Content:** Define `Type.Object(...)` schemas for every config section:
  - `EnabledPluginsSchema` — `Type.Optional(Type.Array(Type.String()))`
  - `SystemPromptSchema` — `Type.Optional(Type.String())`
  - `ActivePersonaSchema` — `Type.Optional(Type.Union([Type.String(), Type.Null()]))`
  - `OllamaConfigSchema` — `Type.Optional(Type.Object({ host: Type.Optional(Type.String()), model: Type.Optional(Type.String()) }))`
  - `LlmConfigSchema` — `Type.Optional(Type.Object({ provider: Type.Optional(Type.String()) }))`
  - `OpenRouterConfigSchema` — complex nested object with models array
  - `SessionConfigSchema` — with contextWindowTokens, responseReserveTokens, maxToolIterations, promptOnToolIterationLimit
  - `LspConfigSchema` — with servers record using discriminated union (tcp vs stdio)
  - `McpConfigSchema` — with servers record using discriminated union (stdio vs streamable_http)
  - `CompactionConfigSchema` — with strategy enum, percent values, etc.
  - `MemoryConfigSchema`, `LogConfigSchema`, `PromptFileConfigSchema`
  - `PartialDroneAgentConfigSchema` — the top-level `Type.Partial(Type.Object({...}))`
- **Export:** `PartialDroneAgentConfigSchema` and inferred type `StaticDecode<typeof PartialDroneAgentConfigSchema>`
- **Verification:** TypeScript compiles, inferred type matches existing `PartialDroneAgentConfig`

#### Step 1.3: Add env var interpolation as a post-parse transform
- **Action:** Create a `transformEnvVars(schema: unknown, source: string): unknown` function in `drone-core/src/config-schema.ts`
- **Details:** Recursively walks the parsed object and replaces `${VAR}` patterns in string values. Throws on unset vars (matching current behavior).
- **Verification:** Unit tests for interpolation (set env, unset env, nested objects, arrays)

#### Step 1.4: Replace parsePartialConfig in drone-agent/src/runtime/config.ts
- **Action:** Rewrite `parsePartialConfig` to:
  1. Call `Value.Parse(PartialDroneAgentConfigSchema, raw)` from typebox
  2. Run `transformEnvVars` on the result
  3. Return the typed result
- **Remove:** All 12+ validation helpers, the 300-line `parsePartialConfig` function body, `parseLspServerConfig`, `parseMcpServerConfig`
- **Keep:** `loadConfigLayer`, `findProjectConfigPath`, `loadAgentConfig`, `pathExists`, `CONFIG_DIRECTORY_NAME`, `CONFIG_FILE_NAME`
- **Verification:** All existing config tests pass unchanged

#### Step 1.5: Remove unused type-guards (if no longer needed)
- **Action:** Check if `isRecord` and `isStringArray` from `src/shared/type-guards.ts` are still used elsewhere. If not, remove the file.
- **Verification:** `pnpm build` succeeds, no import errors

#### Step 1.6: Update config-plugin.ts if needed
- **Action:** The `config` plugin (`src/plugins/config/index.ts`) has its own `KNOWN_CONFIG_KEYS` list and `setValue` logic. Verify it still works with the new schema. If the schema exports a list of known keys, use that instead.
- **Verification:** Config plugin tests pass

### Dependencies
- Step 1.1 → 1.2 → 1.3 → 1.4
- Step 1.5, 1.6 can run in parallel after 1.4

### Test Strategy
- All existing `config.test.ts` tests must pass unchanged (they test the same validation behavior)
- New unit tests for `transformEnvVars` in `drone-core/test/config-schema.test.ts`
- TypeScript compilation check that inferred type matches `PartialDroneAgentConfig`

---

## Refactor 2: Split app.tsx into focused hooks and components

**Goal:** Reduce `drone-agent/src/tui/app.tsx` from ~834 lines to ~200 lines by extracting state management into custom hooks and moving inline components to their own files.

**Location:** `drone-agent/src/tui/`

### Steps

#### Step 2.1: Create `src/tui/hooks/useColorOverrides.ts`
- **Action:** Extract all color override state + cycling timer logic into a custom hook
- **Interface:**
  ```ts
  function useColorOverrides(): {
    scheme: DroneColorScheme;
    pushColorOverride: (override: DroneColorOverride) => void;
    popColorOverride: (overrideId: string) => void;
  }
  ```
- **Moves:** `overrides` state, `activeIndex` state, `scheme` memo, color cycle `useEffect`, active index bounds `useEffect`, `pushColorOverride` callback, `popColorOverride` callback
- **Verification:** TUI tests pass

#### Step 2.2: Create `src/tui/hooks/useLlmIndicator.ts`
- **Action:** Extract LLM working indicator state + animation into a custom hook
- **Interface:**
  ```ts
  function useLlmIndicator(): {
    isLlmActive: boolean;
    llmFrame: string;
    llmColor: string;
    setIsLlmActive: (active: boolean) => void;
  }
  ```
- **Moves:** `isLlmActive` state, `llmFrameIndex` state, animation `useEffect`, `LLM_WORKING_FRAMES` constant
- **Verification:** TUI tests pass

#### Step 2.3: Create `src/tui/hooks/useElicitation.ts`
- **Action:** Extract all elicitation state + wiring into a custom hook
- **Interface:**
  ```ts
  function useElicitation(engine: DroneTuiOptions['engine']): {
    activeQuestion: (DroneElicitationQuestion & { uiKey: string }) | null;
    pickerIndex: number;
    commitAnswer: (answer: string) => void;
    cancelQuestion: () => void;
  }
  ```
- **Moves:** `activeQuestion` state, `pickerIndex` state, `questionResolveRef`, `questionRejectRef`, mount `useEffect` (wiring `setElicitation`), `commitAnswer`, `cancelQuestion`, elicitation `useInput`
- **Verification:** TUI tests pass

#### Step 2.4: Create `src/tui/hooks/useChatLog.ts`
- **Action:** Extract chat log entries state + append logic into a custom hook
- **Interface:**
  ```ts
  function useChatLog(): {
    entries: ChatEntry[];
    appendEntry: (entry: Omit<ChatEntry, 'id'>) => void;
    log: (text: string, kind?: ChatEntry['kind']) => void;
  }
  ```
- **Moves:** `entries` state, `entryIdCounter` ref, `appendEntry` callback, `log` callback
- **Verification:** TUI tests pass

#### Step 2.5: Create `src/tui/hooks/useStatusBar.ts`
- **Action:** Extract status bar refresh logic into a custom hook
- **Interface:**
  ```ts
  function useStatusBar(conversation: DroneTuiOptions['conversation'], entriesLength: number): {
    ctxPct: number | null;
    cwd: string;
  }
  ```
- **Moves:** `ctxPct` state, `cwd` state, refresh `useEffect`
- **Verification:** TUI tests pass

#### Step 2.6: Move ElicitationPrompt, FreeformPrompt, FreeformInput to separate files
- **Action:** Create `src/tui/components/ElicitationPrompt.tsx` with all three components
- **Action:** Update imports in `app.tsx`
- **Verification:** TUI tests pass

#### Step 2.7: Refactor app.tsx to use the new hooks
- **Action:** Replace all extracted state with hook calls. The component body should now be:
  1. Hook calls (6 lines)
  2. `buildPromptLabel` + `shortHomePath` + `preview` + `tryParseJson` helpers (keep in file)
  3. Persona color override `useEffect` (keep — it's orchestration, not state)
  4. Mid-panel widget discovery `useEffect` (keep)
  5. `runSlashCommand` callback (keep — it's the dispatch logic)
  6. Global keybindings `useInput` (keep)
  7. Status bar content construction
  8. Render return
- **Verification:** All TUI tests pass unchanged

### Dependencies
- Steps 2.1-2.6 can run in parallel (no interdependencies between hooks)
- Step 2.7 depends on all of 2.1-2.6

### Test Strategy
- All existing `tui.test.tsx` tests must pass unchanged
- Each hook can have its own test file (optional, low priority)
- TypeScript compilation check

---

## Refactor 3: Replace execSync in search.ts with async execFile

**Goal:** Fix event-loop blocking in `drone-agent/src/plugins/search.ts` by replacing `execSync` with `execFile` (promisified), and eliminate shell injection surface by using args arrays.

**Location:** `drone-agent/src/plugins/search.ts`

### Steps

#### Step 3.1: Add `@internal` helper for async subprocess execution
- **Action:** Create `drone-agent/src/shared/exec-async.ts` with a reusable `execFileAsync(command: string, args: string[], options?: { cwd?: string; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }>` function
- **Details:** Uses `promisify(execFile)` from `node:util` (same pattern as `git.ts`)
- **Verification:** Unit test with a simple command

#### Step 3.2: Cache the rg/grep detection at module level
- **Action:** Add a module-level `let hasRipgrep: boolean | null = null` and a `detectRipgrep(): boolean` function that runs `execFile('which', ['rg'])` once and caches the result
- **Verification:** First call probes, subsequent calls use cache

#### Step 3.3: Rewrite search.text tool execute function
- **Action:** Replace the `execSync` block with:
  1. Use `detectRipgrep()` to choose tool
  2. Build args array (not shell string):
     - rg: `['--no-heading', '--line-number', `--max-count=${maxResults}`, ...(fixed ? ['--fixed-strings'] : []), ...(glob ? ['--glob', glob] : []), pattern, searchPath]`
     - grep: `['-rn', ...(fixed ? ['-F'] : ['-E']), `--max-count=${maxResults}`, ...(glob ? [`--include=${glob}`] : []), pattern, searchPath]`
  3. Call `execFileAsync(tool, args, { maxBuffer: 10 * 1024 * 1024 })`
  4. Parse stdout the same way as before
- **Remove:** `quoteArg` function (no longer needed)
- **Verification:** All search tests pass

#### Step 3.4: Update search.test.ts if needed
- **Action:** Verify tests still work. The test creates temp dirs and runs searches — the async change should be transparent.
- **Verification:** `pnpm test search` passes

### Dependencies
- Step 3.1 → 3.3
- Step 3.2 → 3.3
- Step 3.4 can run in parallel with 3.3

### Test Strategy
- All existing `search.test.ts` tests pass unchanged
- New unit test for `execFileAsync` helper
- New unit test for ripgrep detection caching

---

## Honorable Mention A: Replace custom glob in file.ts with fast-glob

**Goal:** Replace the bug-prone hand-rolled `simpleGlob` function in `drone-agent/src/plugins/file.ts` with a well-tested library.

**Location:** `drone-agent/src/plugins/file.ts`

### Behavioral note: `..` in patterns

The current `simpleGlob` only walks **down** from `cwd` into subdirectories. Patterns containing `..` (e.g. `../other/**/*.ts`) silently return zero results because `path.relative(cwd, fullPath)` never starts with `../`. **fast-glob** resolves `..` relative to `cwd` correctly, so `../other/**/*.ts` would search the sibling directory as expected. This is a **fix** of a latent bug, not a regression. No existing tests exercise `..` patterns, so no tests will break.

### Steps

#### Step A.1: Add fast-glob dependency
- **Action:** `pnpm add fast-glob` in `drone-agent/`
- **Verification:** Import works, `pnpm build` succeeds

#### Step A.2: Replace simpleGlob with fast-glob
- **Action:** Replace the `simpleGlob` function body with `fg(pattern, { cwd, absolute: true })`
- **Remove:** The entire `simpleGlob` function (~40 lines)
- **Verification:** `file.glob` tool tests pass

### Dependencies
- Step A.1 → A.2

---

## Honorable Mention B: Fix DroneTuiOptions type duplication

**Goal:** Eliminate the manual re-declaration of engine interface subsets in `drone-agent/src/tui/types.ts` by using `DronePluginEngine` directly.

**Location:** `drone-agent/src/tui/types.ts`

### Steps

#### Step B.1: Import DronePluginEngine type
- **Action:** Add `import type { DronePluginEngine } from '../runtime/plugin-engine.js'` to `types.ts`
- **Action:** Replace the inline `engine: { ... }` type with `engine: Pick<DronePluginEngine, 'listTools' | 'listPlugins' | 'getRegisteredPluginCount' | 'getRegisteredToolCount' | 'getCapability' | 'runHooks' | 'executeTool' | 'getHelpSnippets' | 'renderPromptFragments' | 'getConfig' | 'dispatchSlashCommand' | 'setElicitation' | 'runWorkflow'>`
- **Verification:** `pnpm build` succeeds, TUI tests pass

### Dependencies
- None (independent)

---

## Execution Order

```
Phase 1 (parallel):
  Refactor 1.1 (add typebox dep)
  Refactor 2.1-2.6 (create hooks + move components)
  Refactor 3.1 (create execFileAsync helper)
  Honorable A.1 (add fast-glob dep)
  Honorable B.1 (fix types)

Phase 2 (depends on Phase 1):
  Refactor 1.2-1.3 (define schemas + transform)
  Refactor 3.2 (cache rg detection)
  Honorable A.2 (replace simpleGlob)

Phase 3 (depends on Phase 2):
  Refactor 1.4-1.6 (replace parser, clean up)
  Refactor 2.7 (refactor app.tsx)
  Refactor 3.3-3.4 (rewrite search tool)

Phase 4 (verification):
  pnpm build
  pnpm test
  pnpm typecheck
  pnpm lint
```

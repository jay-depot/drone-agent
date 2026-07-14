---
key: tool-reduction-followup-plan
tags:
  - planning
  - tool-loading
  - utils
  - git
  - swarm
  - architecture
created: 2026-07-13T02:51:38.790Z
updated: 2026-07-13T02:51:38.790Z
---

# Tool Reduction Follow-up Plan (2026-07-12)

## Summary

Three tool-reduction changes across the drone-agent plugin surface:

1. **Utils consolidation** (7→2): Merge the 7 utility tools into 2: `calculator` (arithmetic) and `string` (text operations with an `operation` enum). Not list/mount — just fewer tools.

2. **Git list/mount** (11→3 meta-tools): Convert all 11 git tools to the list/mount pattern using `ToolMountingCache`. Three meta-tools: `git__list_tools`, `git__mount_tool`, `git__unmount_tool`. Hardcoded description. `__list_tools` filtered through persona.

3. **Swarm list/mount** (13→3 meta-tools): Convert all 13 swarm tools to the list/mount pattern using `ToolMountingCache`. Three meta-tools: `swarm__list_tools`, `swarm__mount_tool`, `swarm__unmount_tool`. Drop `defaultHidden` from cached tools (persona filter on `__list_tools` handles visibility). Hardcoded description. `__list_tools` filtered through persona.

**Prerequisite**: The `ToolMountingCache` class and MCP plugin refactor from the `mcp-tool-mounting-cache-and-server-descriptions-plan` must be executed first. This plan reuses the `ToolMountingCache` class and the list/mount patterns established there.

## Motivation

The current session exposes ~89 tools to the LLM (after MCP list/mount). Consolidating utils and converting git + swarm to list/mount reduces the native tool surface by ~18 tools (7 utils → 2, 11 git → 3, 13 swarm → 3 = 8 tools vs 31 today). This further reduces context cost and improves tool selection accuracy.

## Key Design Decisions

1. **Utils uses simple consolidation**, not list/mount — 2 tools is small enough to always mount.
2. **Git and swarm use list/mount with `ToolMountingCache`** — consistent with the MCP pattern.
3. **None pre-mounted** — the LLM discovers and mounts what it needs. Roadmap item to revisit after seeing it live.
4. **Hardcoded `__list_tools` descriptions** — plugin authors know what their tools do; no LLM call needed.
5. **`__list_tools` filtered through persona capability** — only show tools the persona would allow. Requires `persona` as optional dependency.
6. **`__list_tools` always includes descriptions by convention** — flat list of name + description.
7. **Drop `defaultHidden` from cached tools** — the persona filter on `__list_tools` handles visibility before mounting. After mounting, the persona filter in `getLlmTools()` controls native tool visibility. `defaultHidden` on cached-but-unmounted tools is meaningless.

## Step-by-Step Implementation Plan

### Step 1: Consolidate utils plugin (7→2 tools)

**File**: `drone-agent/src/plugins/utils.ts`

Replace the 7 individual tool registrations with 2 consolidated tools:

**`calculator`** (replaces `evaluate_arithmetic`):

```typescript
registration.registerTool({
  name: 'calculator',
  description:
    'Evaluates arithmetic expressions deterministically with proper operator precedence. Supports +, -, *, /, ^, parentheses, decimals.',
  inputSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description:
          'Mathematical expression to evaluate. Supports +, -, *, /, ^, parentheses, decimals.',
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  execute: async input => {
    if (typeof input.expression !== 'string') {
      throw new Error('expression must be a string.');
    }
    const result = evaluateArithmeticExpression(input.expression);
    return JSON.stringify(result, null, 2);
  },
});
```

**`string`** (replaces `count_words`, `count_letters`, `count_characters`, `count_lines`, `count_unique_words`, `count_sentences_paragraphs`, `spell`):

```typescript
registration.registerTool({
  name: 'string',
  description:
    'Performs string analysis operations: count_words, count_letters, count_characters, count_lines, count_unique_words, count_sentences_paragraphs, spell.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'count_words',
          'count_letters',
          'count_characters',
          'count_lines',
          'count_unique_words',
          'count_sentences_paragraphs',
          'spell',
        ],
        description: 'The string operation to perform.',
      },
      target: {
        type: 'string',
        description:
          'The text to analyze (or the string to spell, for the spell operation).',
      },
    },
    required: ['operation', 'target'],
    additionalProperties: false,
  },
  execute: async input => {
    if (
      typeof input.operation !== 'string' ||
      typeof input.target !== 'string'
    ) {
      throw new Error('operation and target must be strings.');
    }
    switch (input.operation) {
      case 'count_words': {
        const words = tokenizeWords(input.target);
        return JSON.stringify(
          { success: true, totalWords: words.length },
          null,
          2
        );
      }
      case 'count_letters': {
        const letters = extractLetters(input.target);
        return JSON.stringify(
          { success: true, totalLetters: letters.length },
          null,
          2
        );
      }
      case 'count_characters': {
        const count = countNonWhitespaceCharacters(input.target);
        return JSON.stringify(
          { success: true, totalCharacters: count },
          null,
          2
        );
      }
      case 'count_lines': {
        const count = countLines(input.target);
        return JSON.stringify({ success: true, totalLines: count }, null, 2);
      }
      case 'count_unique_words': {
        const words = tokenizeWords(input.target);
        const unique = new Set(words).size;
        return JSON.stringify(
          { success: true, uniqueWords: unique, totalWords: words.length },
          null,
          2
        );
      }
      case 'count_sentences_paragraphs': {
        const sentences = countSentences(input.target);
        const paragraphs = countParagraphs(input.target);
        return JSON.stringify(
          {
            success: true,
            totalSentences: sentences,
            totalParagraphs: paragraphs,
          },
          null,
          2
        );
      }
      case 'spell': {
        const chars = Array.from(input.target);
        return JSON.stringify(chars, null, 2);
      }
      default:
        throw new Error(
          `Unknown operation: ${input.operation}. Valid operations: count_words, count_letters, count_characters, count_lines, count_unique_words, count_sentences_paragraphs, spell.`
        );
    }
  },
});
```

The existing helper functions (`tokenizeWords`, `extractLetters`, `countNonWhitespaceCharacters`, `countLines`, `countSentences`, `countParagraphs`, `evaluateArithmeticExpression`) stay unchanged — only the tool registration surface changes.

**Agent**: coder
**Depends on**: nothing
**Tests**: Update `drone-agent/test/utils.test.ts` (if it exists) or add tests for the consolidated `calculator` and `string` tools. Test each operation. Test invalid operation throws.

### Step 2: Convert git plugin to list/mount

**File**: `drone-agent/src/plugins/git/index.ts`

Add `persona` as an optional dependency:

```typescript
metadata: {
  id: 'git',
  // ...
  dependencies: [
    { id: 'persona', optional: true },
  ],
},
```

In `register()`:

```typescript
const personaCap = registration.request<DronePersonaCapability>('persona');
const gitCache = new ToolMountingCache();
```

For each of the 11 git tools (status, diff, log, show, add, restore, commit, branch, stash, fetch, pull), build a `DroneToolDefinition` (with execute, inputSchema, and renderComponent if present) and `addTool` it to `gitCache`. The tool definitions already exist in the individual tool files — just route them through the cache instead of `registerTool` directly.

Register three meta-tools:

- `git__list_tools` — hardcoded description: `"List all available git tools. Tools include: status, diff, log, show, add, restore, commit, branch, stash, fetch, pull. Mount the ones you need with git__mount_tool."` Execute handler: `gitCache.listAvailable()`, filtered through `personaCap.getFilteredTools()` if available.
- `git__mount_tool` — generic mount description. Execute: `gitCache.mountTool(toolName, registration)`.
- `git__unmount_tool` — generic unmount description. Execute: `gitCache.unmountTool(toolName, registration)`.

**Agent**: coder
**Depends on**: `ToolMountingCache` from the MCP plan (prerequisite)
**Tests**: Test that git tools are not mounted eagerly. Test `git__list_tools` returns all 11 tools with descriptions. Test `git__mount_tool` mounts a tool and it appears in `engine.listTools()`. Test `git__unmount_tool` removes it. Test persona filtering.

### Step 3: Convert swarm plugin to list/mount

**File**: `drone-agent/src/plugins/swarm/index.ts` and related tool files

Add `persona` as an optional dependency:

```typescript
metadata: {
  id: 'swarm',
  // ...
  dependencies: [
    { id: 'persona', optional: true },
  ],
},
```

In `register()`:

```typescript
const personaCap = registration.request<DronePersonaCapability>('persona');
const swarmCache = new ToolMountingCache();
```

For each of the 13 swarm tools, build a `DroneToolDefinition` and `addTool` it to `swarmCache`. **Drop `defaultHidden: true`** from `wiki_write` and `wiki_delete` — the persona filter on `__list_tools` handles visibility.

Register three meta-tools:

- `swarm__list_tools` — hardcoded description: `"List all available swarm tools. Tools include: swarm_message, wiki_read, wiki_write, wiki_search, wiki_list, wiki_delete, wiki_lint, swarm_list_beacons, swarm_list_agents, swarm_spawn, swarm_get_spawn, swarm_list_spawns, swarm_terminate_spawn. Mount the ones you need with swarm__mount_tool."` Execute handler: `swarmCache.listAvailable()`, filtered through `personaCap.getFilteredTools()` if available.
- `swarm__mount_tool` — generic mount description. Execute: `swarmCache.mountTool(toolName, registration)`.
- `swarm__unmount_tool` — generic unmount description. Execute: `swarmCache.unmountTool(toolName, registration)`.

**Agent**: coder
**Depends on**: `ToolMountingCache` from the MCP plan (prerequisite)
**Tests**: Test that swarm tools are not mounted eagerly. Test `swarm__list_tools` returns all 13 tools with descriptions. Test `swarm__mount_tool` mounts a tool. Test `swarm__unmount_tool` removes it. Test persona filtering. Test that `defaultHidden` is no longer set on wiki_write/wiki_delete.

### Step 4: Update tests

**Files**: `drone-agent/test/git-plugin.test.ts`, `drone-agent/test/swarm-spawn.test.ts`, and any other affected test files

1. **Git tests**: Update existing tests that assert git tools are registered at init. They should now assert only meta-tools are registered, and tools must be mounted first. Add tests for list/mount/unmount flow.

2. **Swarm tests**: Update existing tests that assert swarm tools are registered at init. Same pattern as git tests. Verify `defaultHidden` is dropped from wiki_write/wiki_delete.

3. **Utils tests**: Update tests for the consolidated `calculator` and `string` tools.

**Agent**: coder
**Depends on**: Steps 1-3
**Tests**: Self-referential.

### Step 5: Update AGENTS.md

**File**: `AGENTS.md`

Update relevant sections:

- Utils plugin: note consolidation to 2 tools
- Git plugin: note list/mount pattern
- Swarm plugin: note list/mount pattern
- Note that `ToolMountingCache` is reused from the MCP plan
- Note the convention: `__list_tools` always includes descriptions, filtered through persona

**Agent**: coder
**Depends on**: Steps 1-4
**Tests**: N/A (documentation)

### Step 6: Add roadmap entries

**File**: project memory `roadmap`

Add two items:

1. **Pre-mounting check-in**: After seeing list/mount live for a while (git, swarm, MCP), check in on whether some tools should be pre-mounted by default. Some commonly-used tools (e.g., git status, git diff) might benefit from being always available, while less common ones (e.g., git stash, swarm_spawn) stay in the cache. This is a UX decision that needs real-world observation.

2. **LSP ergonomics**: When we get to converting LSP to list/mount (or otherwise improving LSP tool ergonomics), we want to:
   - Give the LLM a way to provide the text it's looking at for "cursor position" based tools
   - Figure out the correct cursor position ourselves (the LLM shouldn't have to guess line/column numbers)
   - Otherwise find ways to make LSP more ergonomic for the model

**Agent**: plan (this persona)
**Depends on**: nothing (done as part of plan finalization)

### Step 7: Validation

1. `pnpm -r run build` — must pass
2. `pnpm run lint` — must pass
3. `pnpm -r run typecheck` — must pass
4. All LSP diagnostics clean
5. `pnpm -r run test` (fast suite) — must pass
6. `pnpm -r run test:integration` — MCP integration tests still pass

**Agent**: coder
**Depends on**: Steps 1-5

## Validation Criteria

- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm run lint` passes with zero errors
- [ ] `pnpm -r run typecheck` passes with zero errors
- [ ] All LSP diagnostics are clean
- [ ] `pnpm -r run test` (fast suite) passes with zero failures
- [ ] Utils plugin has exactly 2 tools: `calculator` and `string`
- [ ] `string` tool supports all 7 operations: count_words, count_letters, count_characters, count_lines, count_unique_words, count_sentences_paragraphs, spell
- [ ] Git plugin mounts only meta-tools at init (3: list_tools, mount_tool, unmount_tool)
- [ ] Git `__list_tools` returns all 11 tools with descriptions
- [ ] Git `__mount_tool` mounts a tool and it appears in `engine.listTools()`
- [ ] Git `__unmount_tool` removes a mounted tool
- [ ] Git `__list_tools` filters through persona when available
- [ ] Swarm plugin mounts only meta-tools at init (3: list_tools, mount_tool, unmount_tool)
- [ ] Swarm `__list_tools` returns all 13 tools with descriptions
- [ ] Swarm `__mount_tool` mounts a tool and it appears in `engine.listTools()`
- [ ] Swarm `__unmount_tool` removes a mounted tool
- [ ] Swarm `__list_tools` filters through persona when available
- [ ] `defaultHidden` is no longer set on wiki_write or wiki_delete
- [ ] AGENTS.md updated
- [ ] Roadmap entries added (pre-mounting check-in, LSP ergonomics)

## Prerequisites

This plan depends on the `ToolMountingCache` class and the MCP plugin list/mount refactor from the `mcp-tool-mounting-cache-and-server-descriptions-plan`. That plan must be executed first. Specifically:

- `ToolMountingCache` class must exist in `drone-core/src/utils.ts`
- The MCP plugin must be refactored to use per-server `ToolMountingCache` instances
- The `__list_tools` persona filtering pattern must be established

---
key: file-apply-diff-v2-content-anchors
tags:
  - plan
  - file-plugin
  - diff-format
  - v2
created: 2026-07-01T22:09:51.874Z
updated: 2026-07-01T22:09:51.874Z
---

# Plan: Redesign `file__apply_diff` with Content-Anchor-Based Patch Format

## Summary

The current `file__apply_diff` tool uses **line numbers** (`startLine`) as the primary location mechanism, with exact-string-match verification of `oldLines`. This is fragile — LLMs are notoriously bad at counting lines, and a single line added/removed above the edit point invalidates every subsequent hunk. The tool also provides poor error feedback when verification fails, making self-correction difficult.

This plan redesigns the tool to use a **content-anchor-based patch format** inspired by OpenAI's V4A diff format. The key changes:

1. **Replace line numbers with content anchors** — hunks are located by matching context lines, not by counting lines
2. **Add progressive fuzzy matching** — a 3-level cascade (exact → strip trailing whitespace → strip all whitespace) with fuzz tracking
3. **Improve error messages** — structured, specific errors that tell the LLM exactly what went wrong and where
4. **Enhance the tool description** — a mini-tutorial with examples, since the format is new to the model
5. **Keep the JSON schema** — the tool remains a structured JSON tool call (not a freeform text format), but the schema changes to accept content anchors instead of line numbers

## Why Not a Freeform Text Format?

The research notes that OpenAI's V4A is a text-based format because the model outputs raw text. In drone-agent, tools are called via structured JSON from the LLM. The JSON schema approach is actually *better* for us because:
- We can constrain the output format at the API level (structured outputs)
- We don't need a Lark grammar or CFG constraint
- The model doesn't need to learn a new text format — it just needs to provide the right data in the right JSON fields

So we adapt the *principles* of V4A (content anchors, no line numbers, progressive matching, structured errors) to our JSON schema.

## Step-by-Step Implementation

### Step 1: Update `diff-renderer.ts` — Add `DiffHunkV2` type and fuzz tracking

**File:** `drone-agent/src/shared/diff-renderer.ts`

**Changes:**
- Add a new `DiffHunkV2` interface that includes `fuzz` level and `anchor` info
- Update `DiffSummary` to include `fuzzLevel` (max fuzz across all hunks)
- Keep backward compatibility with the existing `DiffHunk` type (the renderer is used by both old and new code paths, but since we're replacing the tool, we can just update the types)

**New types to add:**

```typescript
/** Fuzz level for a matched hunk */
export type FuzzLevel = 0 | 1 | 100;

/** Hunk input for the V2 apply_diff (content-anchor-based) */
export interface DiffHunkV2 {
  /** Content anchor line(s) — code that uniquely identifies the location */
  anchors: string[];
  /** Lines expected before the edit point (context) */
  contextBefore: string[];
  /** Lines to remove (old code) */
  oldLines: string[];
  /** Lines to insert (new code) */
  newLines: string[];
  /** Lines expected after the edit point (context) */
  contextAfter: string[];
  /** Fuzz level used to match this hunk (0 = exact, 1 = trailing whitespace, 100 = all whitespace) */
  fuzz?: FuzzLevel;
}
```

**Update `DiffSummary`:**
```typescript
export interface DiffSummary {
  hunks: number;
  additions: number;
  deletions: number;
  maxFuzz?: FuzzLevel;  // highest fuzz level used across all hunks
}
```

### Step 2: Create `patch-applier.ts` — The core patch matching and application logic

**File:** `drone-agent/src/shared/patch-applier.ts` (new file)

This module implements the progressive matching strategy and is the heart of the redesign.

```typescript
import type { FuzzLevel } from './diff-renderer.js';

export interface PatchHunk {
  /** Content anchor line(s) — code that uniquely identifies the location */
  anchors: string[];
  /** Lines expected before the edit point (context) */
  contextBefore: string[];
  /** Lines to remove (old code) */
  oldLines: string[];
  /** Lines to insert (new code) */
  newLines: string[];
  /** Lines expected after the edit point (context) */
  contextAfter: string[];
}

export interface PatchResult {
  success: boolean;
  appliedHunks: AppliedHunk[];
  errors: PatchError[];
}

export interface AppliedHunk {
  anchors: string[];
  fuzz: FuzzLevel;
  /** 1-based line number where the hunk was applied */
  appliedAtLine: number;
}

export interface PatchError {
  hunkIndex: number;
  message: string;
  detail: string;
  /** The anchor lines that were used to search */
  anchors: string[];
  /** What was found at the best match location (for context mismatch) */
  foundContextBefore?: string[];
  foundContextAfter?: string[];
  foundOldLines?: string[];
}
```

**Matching algorithm (3-level cascade):**

```
For each hunk:
  1. Search the file for the anchor line(s) — find ALL occurrences
  2. For each anchor occurrence, try to match the full context (contextBefore + oldLines + contextAfter):
     Level 0: Exact match of all lines
     Level 1: Strip trailing whitespace from all lines
     Level 100: Strip ALL whitespace from all lines
  3. If a match is found at any level, record the fuzz level and apply
  4. If no match is found, record a detailed error
```

**Key design decisions:**
- Anchors are optional — if not provided, fall back to searching the whole file for the context
- Multiple anchors can be provided for hierarchical disambiguation (e.g., `["class BaseClass", "    def method():"]`)
- Hunks are applied bottom-up (like the current implementation) to avoid position invalidation
- The `PatchError` type provides structured feedback so the LLM can self-correct

### Step 3: Rewrite `file__apply_diff` tool in `file.ts`

**File:** `drone-agent/src/plugins/file.ts`

**Changes to the tool registration:**

**New tool description (mini-tutorial style):**

```typescript
name: 'apply_diff',
description:
  'Apply a patch to a file using content-anchored hunks. ' +
  'Each hunk is located by matching context lines in the file, not by line numbers. ' +
  'This makes patches robust to file evolution.\n\n' +
  'Each hunk has:\n' +
  '  - anchors: Optional code lines that uniquely identify the location ' +
  '(e.g., ["class Foo:", "    def bar():"]). Use multiple anchors for ' +
  'disambiguation in nested scopes.\n' +
  '  - contextBefore: 2-3 lines of code immediately above the edit point.\n' +
  '  - oldLines: The exact lines to remove (can be empty for pure insertion).\n' +
  '  - newLines: The lines to insert (can be empty for pure deletion).\n' +
  '  - contextAfter: 2-3 lines of code immediately below the edit point.\n\n' +
  'Matching is progressive: exact match first, then trailing whitespace ' +
  'normalization, then full whitespace normalization. The fuzz level is ' +
  'reported so you can see how cleanly the patch applied.\n\n' +
  'Example — replacing a function body:\n' +
  '  {\n' +
  '    "anchors": ["def example():"],\n' +
  '    "contextBefore": ["", "def example():", "    \"\"\"Docstring\"\"\""],\n' +
  '    "oldLines": ["    pass"],\n' +
  '    "newLines": ["    return 42"],\n' +
  '    "contextAfter": ["", "", ""]\n' +
  '  }\n\n' +
  'Example — adding a new method to a class:\n' +
  '  {\n' +
  '    "anchors": ["class Calculator:"],\n' +
  '    "contextBefore": ["    def subtract(self, a, b):", "        return a - b", ""],\n' +
  '    "oldLines": [],\n' +
  '    "newLines": ["    def multiply(self, a, b):", "        return a * b", ""],\n' +
  '    "contextAfter": ["    def divide(self, a, b):", "        return a / b"]\n' +
  '  }',
```

**New input schema:**

```typescript
inputSchema: {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path to the file.' },
    hunks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          anchors: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional content anchor lines to locate the edit site. ' +
              'Use multiple anchors for hierarchical disambiguation ' +
              '(e.g., ["class Foo:", "    def bar():"]). ' +
              'If omitted, the tool searches the whole file for the context.',
          },
          contextBefore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Lines of code immediately above the edit point. ' +
              'These are matched (with fuzzy fallback) to verify location. ' +
              'Provide 2-3 lines for reliable anchoring.',
          },
          oldLines: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The exact lines to remove at this location. ' +
              'Empty array means pure insertion (no deletion).',
          },
          newLines: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The lines to insert at this location. ' +
              'Empty array means pure deletion (no insertion).',
          },
          contextAfter: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Lines of code immediately below the edit point. ' +
              'These are matched (with fuzzy fallback) to verify location. ' +
              'Provide 2-3 lines for reliable anchoring.',
          },
        },
        required: ['newLines'],
        additionalProperties: false,
      },
    },
    color: {
      type: 'boolean',
      description:
        'Enable ANSI color coding in output. Default: auto-detect from environment.',
    },
  },
  required: ['path', 'hunks'],
  additionalProperties: false,
},
```

**New execute logic:**

```typescript
execute: async input => {
  // Validate inputs
  // Read file
  // For each hunk (processed bottom-up):
  //   1. If anchors provided, find all anchor occurrences in file
  //   2. For each occurrence (or the whole file if no anchors), try 3-level match
  //   3. Apply the hunk at the matched location
  //   4. Record fuzz level
  // Write file
  // Return structured result with fuzz info and diff
}
```

**Error messages (structured, specific):**

| Error | When |
|-------|------|
| `"Hunk {i}: anchor not found: {anchor}"` | Anchor line doesn't exist anywhere in file |
| `"Hunk {i}: context before does not match at anchor location"` | `contextBefore` doesn't match near the anchor |
| `"Hunk {i}: old lines do not match at anchor location"` | `oldLines` don't match at the matched location |
| `"Hunk {i}: context after does not match at anchor location"` | `contextAfter` doesn't match after the edit |
| `"Hunk {i}: no anchors provided and context not found anywhere in file"` | No anchors and context doesn't match anywhere |
| `"Hunk {i}: ambiguous — {n} anchor matches found, context matches {m} of them"` | Multiple anchor matches, context disambiguates partially |

Each error includes the actual content found at the location so the LLM can self-correct.

### Step 4: Update `diff-renderer.ts` — Support new hunk format in rendering

**File:** `drone-agent/src/shared/diff-renderer.ts`

**Changes:**
- Update `renderDiff` to accept the new hunk format (or add a `renderDiffV2` function)
- Include fuzz level in the rendered output (e.g., `@@ -12,3 +12,3 @@ (fuzz: 1)`)
- The diff output should still show the unified-diff-style display with +/- prefixes

### Step 5: Update tests

**File:** `drone-agent/test/file.test.ts`

**Add test cases for the new format:**

1. **Basic replacement** — anchor + contextBefore + oldLines + newLines + contextAfter
2. **Pure insertion** — empty oldLines
3. **Pure deletion** — empty newLines
4. **Multiple anchors** — hierarchical disambiguation
5. **Fuzzy matching level 1** — trailing whitespace differences
6. **Fuzzy matching level 100** — whitespace-only differences
7. **Anchor not found** — verify error message
8. **Context mismatch** — verify error message with actual content
9. **Multiple hunks** — verify bottom-up application
10. **No anchors, context-only** — verify fallback search

### Step 6: Update `AGENTS.md` if needed

**File:** `AGENTS.md`

The `AGENTS.md` currently documents the tool as:
> `file__apply_diff` — Apply hunks to a file. Each hunk has startLine, optional oldLines (for verification), and newLines (to insert).

Update this to reflect the new content-anchor-based format.

## Dependencies and Order

```
Step 1 (diff-renderer types) → Step 2 (patch-applier) → Step 3 (file.ts rewrite)
                                                              ↓
Step 4 (diff-renderer update) ←───────────────────────────────┘
                                                              ↓
Step 5 (tests) ←──────────────────────────────────────────────┘
                                                              ↓
Step 6 (AGENTS.md update)
```

Steps 1 and 2 can be done in parallel. Step 3 depends on both. Step 4 can be done alongside Step 3 (they touch different files). Step 5 depends on Step 3. Step 6 is last.

## Validation Criteria

1. **All LSP checks pass** — `pnpm typecheck` produces zero errors
2. **All existing tests pass** — `pnpm test` passes (existing file tests + new tests)
3. **Linting passes** — `pnpm lint` produces zero errors
4. **New tests cover**:
   - All 10 test scenarios listed in Step 5
   - Edge cases: empty file, single-line file, file with trailing newline, file without trailing newline
5. **Manual verification**: The tool can be tested by running a quick smoke test against a known file
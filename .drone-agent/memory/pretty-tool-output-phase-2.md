---
key: pretty-tool-output-phase-2
tags:
  - plan
  - tui
  - pretty-output
created: 2026-07-21T19:35:20.294Z
updated: 2026-07-21T19:41:46.726Z
---

# Plan: pretty-tool-output-phase-2

## Summary

Extend the custom TUI tool rendering from the first phase to cover 12 more tools across 6 plugins: `utils`, `config`, `memory`, `skills`, `persona`, `notepad`, and `self-improvement` (insight only). Each gets a purpose-built Ink component that replaces the generic `ToolCallProgress` JSON-blob fallback.

Also includes three retroactive tweaks to the phase 1 components:

1. Add tool names (e.g. `file__read`, `file__write`) to the running/done headers of `FileReadBlock`, `FileWriteBlock`, `FileApplyDiffBlock`, `FileListBlock`, `FileGlobBlock`
2. Bump `FileReadBlock` preview from 5 to 10 lines
3. Thread user's syntax highlighting settings through to `FileReadBlock` so it uses the configured colors instead of hardcoded `SYNTAX_COLORS`

Branch: `pretty-tool-output-phase-2`

## What to build

### Infrastructure changes

**`drone-core/src/session-types.ts`** — Add two optional fields to `ToolRenderState`:

```typescript
export type ToolRenderState = {
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  status: 'running' | 'done' | 'error';
  scheme: unknown;
  outputLines?: string[];
  /** User-configured syntax highlighting colors (from tui.syntaxHighlighting.colors). */
  syntaxColors?: Record<string, string>;
  /** User-configured code background color (from tui.syntaxHighlighting.codeBackground). */
  codeBackground?: string;
};
```

**`drone-agent/src/tui/app.tsx`** — In the `toolCallBatch` and `toolResultBatch` event handlers, pass `syntaxColors` and `codeBackground` through to the custom render component:

```typescript
const component = customRender({
  name: tc.name,
  arguments: tc.arguments,
  status: 'running' as const,
  scheme: s as unknown,
  syntaxColors: syntaxColorsRef.current,
  codeBackground: codeBackgroundRef.current,
}) as React.ReactNode;
```

(Same for `toolResultBatch` and `toolProgress` handlers.)

### Phase 1 retroactive tweaks

#### A. Add tool names to headers

Modify these components to include the tool name in running/done headers:

- **`FileReadBlock.tsx`** — running: `… file__read /path`, done: `✓ file__read /path (1–10 of 10 lines)`
- **`FileWriteBlock.tsx`** — running: `… file__write /path` (done already says `✓ Wrote /path`, leave as-is)
- **`FileApplyDiffBlock.tsx`** — running: `… file__apply_diff /path`, done: `✓ file__apply_diff /path`
- **`FileListBlock.tsx`** — running: `… file__list /path`, done: `file__list /path`
- **`FileGlobBlock.tsx`** — running: `… file__glob pattern`, done: `file__glob pattern`

#### B. Bump preview to 10 lines

In `FileReadBlock.tsx`, change:

```typescript
const previewLines = contentLines.slice(0, 5);
```

to:

```typescript
const previewLines = contentLines.slice(0, 10);
```

#### C. Use user's syntax colors

In `FileReadBlock.tsx`, instead of hardcoding `SYNTAX_COLORS`:

```typescript
const tree = lowlight.highlight(lang, previewCode);
highlighted = renderHighlightedTree(tree, 'gray', SYNTAX_COLORS);
```

Use the state's `syntaxColors` and `codeBackground`:

```typescript
const syntaxColors = (state.syntaxColors ?? SYNTAX_COLORS) as Record<
  string,
  string
>;
const codeBg = state.codeBackground ?? 'gray';
// ...
const tree = lowlight.highlight(lang, previewCode);
highlighted = renderHighlightedTree(tree, codeBg, syntaxColors);
```

### Render components (13 new files)

All go in `drone-agent/src/tui/components/`.

#### 1. `UtilsBlock.tsx`

Single component for both `utils__calculator` and `utils__string`.

**Running state:**

```
… calculator("5 + 5")
… string("count_words", "hello world")
```

**Done state (calculator):**

```
✓ calculator: "5 + 5" = 10
```

If `ok: false`, show error in `scheme.error`.

**Done state (string):**

```
✓ string: count_words → 2 words
✓ string: count_letters → 10 letters
✓ string: count_characters → 8 characters
✓ string: count_lines → 3 lines
✓ string: count_unique_words → 2 unique (3 total)
✓ string: count_sentences_paragraphs → 2 sentences, 1 paragraph
✓ string: spell → s t r a w b e r r y
```

Parse the JSON result, extract the relevant fields, and render a compact one-liner.

#### 2. `ConfigGetBlock.tsx`

**Running:**

```
… config.get("ollama.model")
… config.get()  (no key = full config)
```

**Done (with key):**

```
✓ config.get: ollama.model = "llama3"  (source: project)
```

**Done (without key — full config):**

```
✓ config.get: all  (N keys, source: project)
```

Don't dump the full config — just a summary line.

#### 3. `ConfigSetBlock.tsx`

**Running:**

```
… config.set("ollama.model", "llama3")
```

**Done:**

```
✓ config.set: ollama.model → project scope  (restart to apply)
```

#### 4. `MemoryManageBlock.tsx`

**Running:**

```
… memory.manage("store", "my-key")
… memory.manage("recall", "my-key")
… memory.manage("delete", "my-key")
```

**Done (store):**

```
✓ memory.store: "my-key"  (tags: [tag1, tag2])
```

**Done (recall):**

```
✓ memory.recall: "my-key"
<value content rendered as Markdown via the shared Markdown component>
```

**Done (delete):**

```
✓ memory.delete: "my-key"  (removed: true)
```

#### 5. `MemoryBrowseBlock.tsx`

**Running:**

```
… memory.browse("list", prefix="pretty-")
… memory.browse("search", "query")
```

**Done (list):**

```
✓ memory.list (prefix: "pretty-")
  key1  (tags: [tag1])
  key2  (tags: [tag2])
  (N entries)
```

**Done (search):**

```
✓ memory.search "query"
  key1  (tags: [tag1])
  key2  (tags: [tag2])
  (N results)
```

#### 6. `SkillsRecallBlock.tsx`

**Running:**

```
… skills.recall("ui-architecture")
```

**Done:**

```
✓ skills.recall: "ui-architecture"
<body content rendered as Markdown via the shared Markdown component>
```

#### 7. `SkillsListBlock.tsx`

**Running:**

```
… skills.list()
```

**Done:**

```
✓ skills.list: N skills
  - id1  (description)
  - id2  (description)
```

#### 8. `SkillsCreateBlock.tsx`

**Running:**

```
… skills.create(...)
```

**Done:**

```
✓ skills.create: Workflow completed.
```

#### 9. `PersonaListBlock.tsx`

**Running:**

```
… persona.list()
```

**Done:**

```
✓ persona.list: N personas
  active: <id> or (none)
  - id1  (description)
  - id2  (description)
```

#### 10. `PersonaSelectBlock.tsx`

**Running:**

```
… persona.select("plan")
```

**Done:**

```
✓ persona.select: "plan" → active
```

On error:

```
✗ persona.select: Unknown persona "foo"
```

#### 11. `PersonaCreateBlock.tsx`

**Running:**

```
… persona.create(...)
```

**Done:**

```
✓ persona.create: Workflow completed.
```

#### 12. `NotepadBlock.tsx`

**Running:**

```
… notepad.manage("set", ...)
… notepad.manage("clear")
… notepad.manage("append", ...)
```

**Done (set/append):**

```
✓ notepad.set
<full notepad content rendered as Markdown via the shared Markdown component>
```

**Done (clear):**

```
✓ notepad.clear
```

#### 13. `SelfImprovementInsightBlock.tsx`

**Running:**

```
… self-improvement.insight("record", ...)
… self-improvement.insight("list")
… self-improvement.insight("recall", "persona", "plan")
```

**Done (record):**

```
✓ self-improvement.insight: recorded for persona "plan"
```

**Done (list):**

```
✓ self-improvement.insight: list
  persona/plan (N entries)
  skill/ui-architecture (M entries)
```

**Done (recall):**

```
✓ self-improvement.insight: recall persona "plan"
  - <insight text>
  - <insight text>
  (N entries)
```

### Plugin registration changes

In each plugin file, add `renderComponent` to the tool definition. The pattern is the same as phase 1:

```typescript
// In utils.ts:
registration.registerTool({
  name: 'calculator',
  // ... existing fields ...
  renderComponent: state => UtilsBlock({ state }),
});

registration.registerTool({
  name: 'string',
  // ... existing fields ...
  renderComponent: state => UtilsBlock({ state }),
});
```

Files to modify:

- `drone-agent/src/plugins/utils.ts` — add `renderComponent` to both tools
- `drone-agent/src/plugins/config/index.ts` — add to `get` and `set`
- `drone-agent/src/plugins/memory/index.ts` — add to `manage` and `browse`
- `drone-agent/src/plugins/skills/index.ts` — add to `recall`, `list`, `create`
- `drone-agent/src/plugins/persona/index.ts` — add to `list`, `select`, `create`
- `drone-agent/src/plugins/notepad.ts` — add to `manage`
- `drone-agent/src/plugins/self-improvement/tools/insight.ts` — add to `insight` tool

### Tests

Add tests in `test/pretty-tool-output-phase-2.test.tsx` following the same pattern as `test/pretty-tool-output.test.tsx`:

- Each component gets a `describe` block
- Each block tests: running state, done state, error state
- For components with multiple modes (calculator vs string, list vs search), test each mode
- Use `ink-testing-library`'s `render` and `lastFrame()`
- Use `DEFAULT_GRAYSCALE_SCHEME` from theme
- Use the same `makeState()` helper pattern

Update existing tests in `test/pretty-tool-output.test.tsx` to reflect the new tool-name headers and 10-line preview.

## Validation criteria

1. `pnpm typecheck` passes with zero errors
2. `pnpm lint:eslint` and `pnpm lint:prettier` pass with zero errors
3. `pnpm build` passes with zero errors
4. `pnpm test` passes — all existing tests plus new phase-2 tests
5. LSP diagnostics are clean across all modified files
6. Each new component renders correctly in all three states (running/done/error)
7. Each new component handles malformed JSON results gracefully (falls back to showing the raw result string)
8. `FileReadBlock` shows tool name in header, 10-line preview, and uses user's syntax colors
9. Other phase 1 file blocks show tool names in their headers

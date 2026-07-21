---
key: pretty-tool-output
tags:
  - plan
  - tui
  - pretty-tool-output
  - exec
  - file
  - search
  - streaming
created: 2026-07-21T19:03:11.132Z
updated: 2026-07-21T19:03:11.132Z
---

# Plan: pretty-tool-output

## Summary

Replace the generic `ToolCallProgress` JSON-blob fallback in the TUI with purpose-built, human-readable render components for the seven core workhorse tools: `exec__run`, `file__read`, `file__write`, `file__apply_diff`, `file__list`, `file__glob`, and `search__text`.

Also adds genuine streaming output for `exec__run` via a new `toolProgress` conversation event type, a progress callback on `DroneToolDefinition.execute`, and an `outputLines` accumulator on `ToolRenderState`.

Branch: `pretty-tool-output`

---

## Step-by-step Implementation

### Step 1 — Add `toolProgress` to `DroneConversationEvent` and `outputLines` to `ToolRenderState` [`drone-core`]

**File:** `drone-core/src/session-types.ts`

1. Add a new event kind to the `DroneConversationEvent` union:
   ```ts
   | { kind: 'toolProgress'; name: string; content: string }
   ```
2. Add an optional field to `ToolRenderState`:
   ```ts
   outputLines?: string[];
   ```

---

### Step 2 — Add a progress callback to `DroneToolDefinition.execute` [`drone-core`]

**File:** `drone-core/src/plugin-system.ts`

Change the `execute` signature from:
```ts
execute: (input: Record<string, unknown>) => Promise<string>;
```
to:
```ts
execute: (
  input: Record<string, unknown>,
  onProgress?: (chunk: string) => void
) => Promise<string>;
```

The `onProgress` parameter is optional so all existing tool implementations continue to compile without changes.

---

### Step 3 — Thread `onProgress` through the conversation service [`drone-agent`]

**File:** `drone-agent/src/runtime/conversation-service.ts`

When calling `engine.executeTool(name, args)`:
1. Build an `onProgress` callback that emits a `toolProgress` event via the engine's conversation event emitter:
   ```ts
   const onProgress = (chunk: string) => {
     engine.emitConversationEvent({ kind: 'toolProgress', name, content: chunk });
   };
   ```
2. Pass `onProgress` as the second argument to `executeTool`.

**File:** `drone-agent/src/runtime/plugin-engine.ts`

Update `executeTool` to accept and forward the `onProgress` callback to the registered tool's `execute` function.

---

### Step 4 — Update `exec.ts` to stream output via `onProgress` [`drone-agent`]

**File:** `drone-agent/src/plugins/exec.ts`

1. Change `runCommand` to accept an `onProgress?: (chunk: string) => void` parameter.
2. Instead of (only) accumulating into `stdout` and `stderr` buffers:
   - On `child.stdout.on('data', chunk)`: still append to `stdout` buffer AND call `onProgress?.(String(chunk))`
   - On `child.stderr.on('data', chunk)`: still append to `stderr` buffer AND call `onProgress?.(String(chunk))`
3. The final resolved value remains `{command, cwd, exitCode, stdout, stderr}` — the LLM return shape is unchanged.
4. Update the `execute` function to accept and forward `onProgress`:
   ```ts
   execute: async (input, onProgress) => {
     return runCommand(input, onProgress);
   }
   ```

---

### Step 5 — Handle `toolProgress` in `app.tsx` [`drone-agent`]

**File:** `drone-agent/src/tui/app.tsx`

1. Add a `Map<string, string[]>` ref (keyed by tool name) to accumulate `outputLines` per in-flight tool call.
2. In the `toolCallBatch` handler: initialise an empty `string[]` entry in the map for each new tool call.
3. Add a new handler for `toolProgress` events:
   - Append `event.content` to the appropriate accumulator entry.
   - Re-call the tool's `renderComponent` with updated `ToolRenderState` (including `outputLines`) and call `updateItem()` with the new node.
4. In the `toolResultBatch` handler: read the final accumulated lines from the map and include them as `outputLines` in the final `ToolRenderState`. Clean up the accumulator entry after commit.

**Note on tool call identity:** The `toolCallBatch` event includes `name` and `arguments`; the `toolProgress` event includes `name`. If multiple concurrent calls to the same tool name could occur, use a composite key. For now, `name` alone is sufficient since `exec__run` is not typically called in parallel with itself.

---

### Step 6 — Create `ExecRunBlock.tsx` [`drone-agent`]

**File:** `drone-agent/src/tui/components/ExecRunBlock.tsx`

```
// Running:
//   … exec__run $ <command>
//
// Done (exit 0):
//   ✓ exec__run $ <command>
//   <outputLines joined, no truncation limit>
//
// Done (exit non-zero):
//   ✗ exec__run $ <command>  (exit <code>)
//   <outputLines joined>
//
// Error (threw):
//   ✗ exec__run $ <command>
//   <error message>
```

- First line: `<indicator> exec__run $ <command>` in `scheme.info`
- Subsequent lines: `outputLines` joined (each chunk rendered as-is, in a neutral color)
- On non-zero exit (parsed from result JSON): show `(exit <code>)` suffix and color first line with `scheme.error`
- Trailing `\n` for scrollback separation

Register on the `exec__run` tool definition:
```ts
renderComponent: state => ExecRunBlock({ state })
```

---

### Step 7 — Create `FileReadBlock.tsx` [`drone-agent`]

**File:** `drone-agent/src/tui/components/FileReadBlock.tsx`

```
// Running:
//   … <path>
//
// Done:
//   ✓ <path> (<startLine>–<endLine> of <totalLines> lines)
//   [up to 5 preview lines, syntax-highlighted]
//   ===
```

- Parse result JSON for `path`, `startLine`, `endLine`, `totalLines`, `content`
- Strip leading `./` from path display
- Syntax-highlight the first 5 lines of `content` using lowlight, reusing the same `renderHighlightedTree` / `lowlight.highlight()` pattern from `Markdown.tsx`
- Infer language from file extension (`.ts` → `typescript`, `.tsx` → `tsx`, `.js` → `javascript`, `.py` → `python`, `.json` → `json`, `.md` → `markdown`, etc.) — add a small `extToLang` helper function
- `===` separator at the end
- Register on `file__read`:
  ```ts
  renderComponent: state => FileReadBlock({ state })
  ```

---

### Step 8 — Create `FileWriteBlock.tsx` [`drone-agent`]

**File:** `drone-agent/src/tui/components/FileWriteBlock.tsx`

```
// Running:
//   … <path>
//
// Done:
//   ✓ Wrote <path>
//
// Error:
//   ✗ <path>: <error>
```

- Parse result JSON for `path`
- Simple one-liner, `scheme.success` on done, `scheme.error` on error
- Register on `file__write`

---

### Step 9 — Create `FileApplyDiffBlock.tsx` [`drone-agent`]

**File:** `drone-agent/src/tui/components/FileApplyDiffBlock.tsx`

```
// Running:
//   … <path>
//
// Done:
//   ✓ <path>
//   +<additions> -<deletions> across <hunks> hunk(s)
//
// Error:
//   ✗ <path>: <error>
```

- Parse result JSON for `path`, `summary.additions`, `summary.deletions`, `summary.hunks`
- `+<n>` in `scheme.success`, `-<n>` in `scheme.error`
- Register on `file__apply_diff`

---

### Step 10 — Create `FileListBlock.tsx` [`drone-agent`]

**File:** `drone-agent/src/tui/components/FileListBlock.tsx`

```
// Running:
//   … <path>
//
// Done:
//   <path>
//   📁 dirname/
//   📄 filename
//   ...
```

- Parse result JSON for `path` and `items[]`
- Directories rendered as `📁 <name>/` in `scheme.info`, files as `📄 <name>` in neutral color
- Register on `file__list`

---

### Step 11 — Create `FileGlobBlock.tsx` [`drone-agent`]

**File:** `drone-agent/src/tui/components/FileGlobBlock.tsx`

```
// Running:
//   … <pattern>
//
// Done:
//   <pattern>
//   /path/to/match1.ts
//   /path/to/match2.ts
//   ...
//   (<N> matches)
```

- Parse result JSON for `pattern`, `matches[]`
- Each match on its own line
- Count summary at the end in `scheme.info`
- Register on `file__glob`

---

### Step 12 — Create `SearchTextBlock.tsx` [`drone-agent`]

**File:** `drone-agent/src/tui/components/SearchTextBlock.tsx`

```
// Running:
//   … <pattern> in <searchPath>
//
// Done:
//   <pattern> in <searchPath>
//   <file>:<line>  <content>
//   <file>:<line>  <content>
//   ...
//   (<resultCount> matches) [truncated]
```

- Parse result JSON for `pattern`, `searchPath`, `results[]`, `resultCount`, `truncated`
- File+line in `scheme.info`, content in neutral color
- `[truncated]` shown in `scheme.warning` if `truncated === true`
- Register on `search__text`

---

### Step 13 — Wire all `renderComponent` registrations [`drone-agent`]

**File:** `drone-agent/src/plugins/file.ts`

Import and register `FileReadBlock`, `FileWriteBlock`, `FileApplyDiffBlock`, `FileListBlock`, `FileGlobBlock` on their respective tool definitions.

**File:** `drone-agent/src/plugins/search.ts`

Import and register `SearchTextBlock` on `search__text`.

**File:** `drone-agent/src/plugins/exec.ts`

Import and register `ExecRunBlock` on `exec__run`.

---

### Step 14 — Add unit tests [`drone-agent`]

**File:** `drone-agent/test/exec.test.ts` (existing)
- Add a test verifying that `onProgress` is called with chunks as they arrive, not just at the end.
- Add a test verifying the final return shape still contains `stdout` and `stderr` separately.

**File:** `drone-agent/test/pretty-tool-output.test.ts` (new)
- For each new render component, test the `running`, `done`, and `error` states using a mock `ToolRenderState`.
- For `FileReadBlock`: test that the first 5 lines are shown and a 6th line is not.
- For `FileGlobBlock`: test the match count summary.
- For `SearchTextBlock`: test the `[truncated]` indicator appears only when `truncated === true`.
- For `ExecRunBlock`: test that `outputLines` are rendered and that a non-zero exit code changes the indicator color.

---

### Step 15 — Validate against all criteria

Run in order:
```sh
pnpm typecheck       # Must pass with zero errors
pnpm -r run lint     # ESLint + Prettier; re-read all modified files after this
pnpm -r run build    # Must compile clean
pnpm -r run test     # Fast suite must pass
```

Check LSP diagnostics after each significant file change.

---

## Validation Criteria

| Check | Required |
|---|---|
| `pnpm typecheck` passes with zero errors | ✅ |
| `pnpm -r run lint` passes (ESLint + Prettier) | ✅ |
| `pnpm -r run build` compiles clean | ✅ |
| `pnpm -r run test` (fast suite) passes | ✅ |
| LSP diagnostics clean across all modified files | ✅ |
| `exec__run`: shows `… exec__run $ <cmd>` while running | ✅ |
| `exec__run`: streams output lines as they arrive (updateItem on each chunk) | ✅ |
| `exec__run`: final result still returns `{stdout, stderr}` to LLM | ✅ |
| `file__read`: shows path + line range header + up to 5 syntax-highlighted preview lines + `===` | ✅ |
| `file__write`: shows `✓ Wrote <path>` | ✅ |
| `file__apply_diff`: shows `✓ <path>` + `+N -N across N hunk(s)` | ✅ |
| `file__list`: shows path header + emoji-prefixed entries | ✅ |
| `file__glob`: shows pattern + matched paths + count | ✅ |
| `search__text`: shows `<pattern> in <path>` + `file:line content` rows + count + truncated indicator | ✅ |
| All new components handle `running`, `done`, and `error` states | ✅ |
| All new render components covered by unit tests | ✅ |
| No dead code, no unused imports | ✅ |
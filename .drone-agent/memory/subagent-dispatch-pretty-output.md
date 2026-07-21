---
key: subagent-dispatch-pretty-output
tags:
  - plan
  - tui
  - pretty-output
  - subagent
created: 2026-07-21T20:33:56.724Z
updated: 2026-07-21T20:33:56.724Z
---

# Plan: subagent-dispatch-pretty-output

## Summary

Add a custom TUI render component for `subagent__dispatch` that shows the kickoff prompt (markdown-rendered), a thin horizontal rule divider, and a live-updating "last subagent action" line while the subagent runs. When the subagent completes, the last action naturally transitions into the subagent's return result (markdown-rendered).

Also adds real-time NDJSON event parsing to the subagent's stdout stream so the parent agent can monitor subagent progress as it happens — a capability that will be useful for other features later.

## Architecture

### How it works

1. The `dispatch` tool's `execute` function currently collects all stdout lines and only processes them at process exit. We add per-line NDJSON parsing that calls `onProgress()` for each event.
2. Progress lines use a prefix convention: `reasoning:<text>`, `tool:<name>(<args>)`, `msg:<content>`, `done:<result>`.
3. The `app.tsx` `toolProgress` handler accumulates these in `outputLines` (as it does for all tools).
4. The custom render component reads `outputLines[last]` for the running "last action" and `state.result` for the completed result.

### Progress line format

Each NDJSON event from the subagent's stdout is parsed and converted to a progress string:

| NDJSON event | Progress string |
|---|---|
| `{kind:"reasoning", content:"..."}` | `reasoning:<text>` |
| `{kind:"toolCall", name:"...", input:{...}}` | `tool:<name>(<truncated-args>)` |
| `{kind:"assistantMessage", content:"..."}` | `msg:<truncated-content>` |
| `{kind:"return", result:"..."}` | `done:<result>` |

Args are truncated to ~80 chars to fit one line. Message content is truncated to ~120 chars.

### Render states

**Running:**
```
… subagent__dispatch - <persona>

<kickoff prompt, markdown rendered>

─────────────────────────────────────

<last action: reasoning text / tool call / message>
```

**Done:**
```
✓ subagent__dispatch - <persona>

<kickoff prompt, markdown rendered>

─────────────────────────────────────

<return result, markdown rendered>
```

**Error:**
```
✗ subagent__dispatch - <persona>

<kickoff prompt, markdown rendered>

─────────────────────────────────────

<error message>
```

## Steps

### Step 1: Add real-time NDJSON parsing to subagent dispatch

**File:** `drone-agent/src/plugins/subagent/plugin.ts`

In the `dispatch` tool's `execute` function, modify the `child.stdout?.on('data', ...)` handler to parse each line as NDJSON and call `onProgress()`:

```ts
child.stdout?.on('data', (data: Buffer) => {
  const lines = data.toString().split('\n').filter(l => l.trim());
  collectedOutput.push(...lines);

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.kind === 'reasoning' && typeof event.content === 'string') {
        onProgress?.(`reasoning:${event.content}`);
      } else if (event.kind === 'toolCall' && typeof event.name === 'string') {
        const args = JSON.stringify(event.input ?? {});
        const truncated = args.length > 80 ? args.slice(0, 77) + '...' : args;
        onProgress?.(`tool:${event.name}(${truncated})`);
      } else if (event.kind === 'assistantMessage' && typeof event.content === 'string') {
        const truncated = event.content.length > 120 ? event.content.slice(0, 117) + '...' : event.content;
        onProgress?.(`msg:${truncated}`);
      } else if (event.kind === 'return' && typeof event.result === 'string') {
        onProgress?.(`done:${event.result}`);
      }
    } catch {
      // Skip invalid JSON
    }
  }
});
```

Also add `onProgress` parameter to the `execute` function signature (it's already passed by the engine, but the current signature doesn't declare it — check if it needs to be added to the function params).

**Note:** The `execute` function currently has signature `async (input): Promise<string>`. The engine passes `onProgress` as the second argument. We need to add it: `async (input, onProgress): Promise<string>`.

### Step 2: Create SubagentDispatchBlock component

**File:** `drone-agent/src/tui/components/SubagentDispatchBlock.tsx` (new file)

```tsx
import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { Markdown } from './Markdown.js';

const DIVIDER = '\n\n─────────────────────────────────────\n\n';

function parseLastAction(outputLines?: string[]): { kind: string; content: string } | null {
  if (!outputLines || outputLines.length === 0) return null;
  const last = outputLines[outputLines.length - 1];
  const colonIdx = last.indexOf(':');
  if (colonIdx === -1) return { kind: 'unknown', content: last };
  return { kind: last.slice(0, colonIdx), content: last.slice(colonIdx + 1) };
}

function extractResult(json: string): string {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed.result === 'string') return parsed.result;
    if (typeof parsed.error === 'string') return parsed.error;
    return json;
  } catch {
    return json;
  }
}

function renderLastAction(action: { kind: string; content: string }, scheme: DroneColorScheme): ReactNode {
  switch (action.kind) {
    case 'reasoning':
      return <Text color={scheme.reasoning} wrap="wrap">{action.content}</Text>;
    case 'tool':
      return <Text color={scheme.toolCall} wrap="wrap">⚡ {action.content}</Text>;
    case 'msg':
      return <Text color={scheme.info} wrap="wrap">{action.content}</Text>;
    case 'done':
      return <Markdown color={scheme.info}>{action.content}</Markdown>;
    default:
      return <Text wrap="wrap">{action.content}</Text>;
  }
}

export function SubagentDispatchBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const persona = typeof state.arguments.persona === 'string' ? state.arguments.persona : undefined;
  const task = typeof state.arguments.task === 'string' ? state.arguments.task : '';
  const lastAction = parseLastAction(state.outputLines);

  const indicator = state.status === 'running' ? '…' : state.status === 'error' ? '✗' : '✓';
  const headerColor = state.status === 'error' ? scheme.error : scheme.info;
  const header = `subagent__dispatch${persona ? ` - ${persona}` : ''}`;

  return (
    <>
      <Text color={headerColor} wrap="wrap">{indicator} {header}</Text>
      <Markdown color={scheme.info}>{task}</Markdown>
      <Text>{DIVIDER}</Text>
      {state.status === 'running' && lastAction && (
        renderLastAction(lastAction, scheme)
      )}
      {state.status === 'done' && (
        <Markdown color={scheme.info}>{extractResult(state.result ?? '')}</Markdown>
      )}
      {state.status === 'error' && (
        <Text color={scheme.error} wrap="wrap">{state.result ?? 'Subagent failed'}</Text>
      )}
      <Text>{'\n'}</Text>
    </>
  );
}
```

### Step 3: Register renderComponent on the dispatch tool

**File:** `drone-agent/src/plugins/subagent/plugin.ts`

Add `renderComponent` to the dispatch tool definition:

```ts
ctx.registerTool({
  name: 'dispatch',
  // ... existing fields ...
  renderComponent: state => SubagentDispatchBlock({ state }),
  execute: async (input, onProgress) => {
    // ... existing implementation with onProgress added ...
  },
});
```

And add the import at the top:
```ts
import { SubagentDispatchBlock } from '../tui/components/SubagentDispatchBlock.js';
```

### Step 4: Add tests

**File:** `drone-agent/test/subagent-dispatch-block.test.tsx` (new file)

Test the SubagentDispatchBlock component in three states:
- **Running**: shows `…` indicator, kickoff prompt rendered as markdown, divider, and last action (reasoning/tool/msg variants)
- **Done**: shows `✓` indicator, kickoff prompt, divider, and result rendered as markdown
- **Error**: shows `✗` indicator, kickoff prompt, divider, and error message

Use `ink-testing-library`'s `render` with a `Static` wrapper (same pattern as other block tests).

### Step 5: Validation

- `pnpm typecheck` — must pass
- `pnpm lint:eslint` + `pnpm lint:prettier` — must pass
- `pnpm build` — must pass
- `pnpm test` — all tests must pass (including new ones)
- LSP diagnostics — must be clean

## Validation Criteria

- [ ] LSP diagnostics clean (no errors or warnings)
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint:eslint` passes
- [ ] `pnpm lint:prettier` passes
- [ ] `pnpm build` passes
- [ ] `pnpm test` passes (all existing + new tests)
- [ ] SubagentDispatchBlock renders correctly in running/done/error states
- [ ] Running state shows `…` indicator, markdown-rendered kickoff, divider, and last action
- [ ] Done state shows `✓` indicator, markdown-rendered kickoff, divider, and markdown-rendered result
- [ ] Error state shows `✗` indicator, markdown-rendered kickoff, divider, and error message
- [ ] Last action updates live as NDJSON events arrive from subagent stdout
- [ ] Reasoning text shows as gray reasoning text
- [ ] Tool calls show as `⚡ toolName(args)` with truncated args
- [ ] Assistant messages show as plain text (truncated)
- [ ] On completion, the last action transitions to the rendered result
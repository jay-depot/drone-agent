---
key: status-bar-tools-yx-plus-slash-tools-filter
tags:
  - plan
  - tui
  - status-bar
  - slash-commands
  - tool-filtering
created: 2026-07-01T22:52:09.679Z
updated: 2026-07-01T22:52:09.679Z
---

# Plan: `tools:Y/X` Status Bar + `/tools` Filtered Listing

## Summary

Two small UI changes to make tool visibility more transparent:

1. **Status bar** shows `tools:available/total` instead of `tools:total`, so the user can see how many tools are actually visible to the LLM (post persona filtering)
2. **`/tools` slash command** shows the filtered (available) tool list, and `/tools --all` shows the full unfiltered list

---

## Step 1: Modify `app.tsx` — compute available tool count

**File:** `drone-agent/src/tui/app.tsx`

**What:** Replace the single `toolCount` with `totalTools` and `availableTools`, and render `tools:availableTools/totalTools`.

**Lines ~389-400:**
```ts
// OLD
const toolCount = opts.engine.getRegisteredToolCount();
// ...
const statusLeft = ` model:${model} │ plugins:${pluginCount} │ tools:${toolCount} │ ctx:${
    ctxPct ?? '?'
  }%${personaLabel} `;
```

```ts
// NEW
import type { DroneToolDescriptor } from 'drone-core';  // add to imports if missing

const totalTools = opts.engine.getRegisteredToolCount();
const allTools = opts.engine.listTools();
const personaCap = opts.engine.getCapability<{
  getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
}>('persona');
const availableTools = personaCap
  ? personaCap.getFilteredTools(allTools).length
  : allTools.filter(t => !t.defaultHidden).length;
// ...
const statusLeft = ` model:${model} │ plugins:${pluginCount} │ tools:${availableTools}/${totalTools} │ ctx:${
    ctxPct ?? '?'
  }%${personaLabel} `;
```

**Note:** `listTools` is already in the `Pick<DronePluginEngine, ...>` in `DroneTuiOptions`. Just need to verify `DroneToolDescriptor` is imported.

---

## Step 2: Modify `/tools` built-in command

**File:** `drone-agent/src/runtime/builtin-commands.ts`

**What:** Change the `/tools` handler to:
- Default: list tools filtered by the active persona (same logic as conversation service's `getLlmTools`)
- `/tools --all`: list all registered tools unfiltered

```ts
// OLD
const toolsCommand: DroneSlashCommand = {
  command: '/tools',
  description: 'List registered tools',
  handler: async (ctx: DroneSlashCommandContext) => {
    const tools = ctx.engine.listTools?.() ?? [];
    const lines = ['Registered tools:'];
    for (const tool of tools) {
      lines.push(`  ${tool.name}`);
      lines.push(`    ${tool.description}`);
    }
    ctx.logger.info(lines.join('\n'));
    return true;
  },
};
```

```ts
// NEW
const toolsCommand: DroneSlashCommand = {
  command: '/tools',
  description: 'List registered tools (/tools --all for full list)',
  handler: async (ctx: DroneSlashCommandContext) => {
    const allTools = ctx.engine.listTools?.() ?? [];
    const showAll = ctx.args.includes('--all');

    let tools: DroneToolDescriptor[];
    if (showAll) {
      tools = allTools;
    } else {
      const personaCap = ctx.engine.getCapability<{
        getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
      }>('persona');
      tools = personaCap ? personaCap.getFilteredTools(allTools) : allTools.filter(t => !t.defaultHidden);
    }

    const lines = showAll
      ? [`All registered tools (${tools.length}):`]
      : [`Available tools (${tools.length}/${allTools.length}):`];
    for (const tool of tools) {
      lines.push(`  ${tool.name}`);
      lines.push(`    ${tool.description}`);
    }
    ctx.logger.info(lines.join('\n'));
    return true;
  },
};
```

Need to add `import type { DroneToolDescriptor } from 'drone-core';` at the top of `builtin-commands.ts`.

---

## Step 3: Update `tui.test.tsx`

**File:** `drone-agent/test/tui.test.tsx`

**Changes:**
1. In the first `makeOptions()` (line ~44): add `listTools: () => [{ name: 'tool-a', description: 'a' }, { name: 'tool-b', description: 'b' }, { name: 'tool-c', description: 'c' }]` so the list matches the count of 3
2. Update assertion: `expect(frame).toContain('tools:3/3')` instead of `expect(frame).toContain('tools:3')`
3. Same for the second `makeOptions()` at line ~195

---

## Step 4: Add tests for `/tools` filtering

**File:** `drone-agent/test/builtin-commands.test.ts` (new file, or append to an existing test file)

**What:** Test that:
- `/tools` shows the filtered set (simulate a persona filtering out some tools)
- `/tools --all` shows the full unfiltered set

---

## Step 5: Verify other tests

**Files to check (no changes expected):**
- `tui-persona-color.test.tsx` — `listTools: () => []` + `getRegisteredToolCount: () => 0` → `tools:0/0`
- `systemprompt.test.tsx` — same → `tools:0/0`
- `helpers.ts` — same → `tools:0/0`

---

## Step 6: Run validation

```bash
pnpm typecheck
pnpm test -- run
pnpm lint
```

## Validation Criteria

- [ ] `pnpm typecheck` passes (no LSP errors)
- [ ] `pnpm test` passes (all existing + new tests)
- [ ] `pnpm lint` passes
- [ ] Status bar shows `tools:Y/X` where Y ≤ X
- [ ] When no persona is active, Y = number of non-`defaultHidden` tools
- [ ] When a persona with `allowedTools` is active, Y = number of tools matching the persona's glob patterns
- [ ] `/tools` shows the filtered list with header `Available tools (Y/X):`
- [ ] `/tools --all` shows the full unfiltered list with header `All registered tools (X):`
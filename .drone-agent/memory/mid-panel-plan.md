---
key: mid-panel-plan
tags:
  []
created: 2026-06-22T18:42:30.611Z
updated: 2026-06-22T18:44:59.588Z
---

# Plan: Right Sidebar → Mid Panel

## Summary
Convert the right sidebar into a horizontal "mid panel" bar between the chat log and input line. Change the todo widget to show a summary count (`TODO: [completed] / [total]`). Add an insights counter widget from the self-improvement plugin (in-memory, session-only count).

## Files to modify

| # | File | Change |
|---|------|--------|
| 1 | `src/tui/components/Sidebar.tsx` | Rename to `MidPanel.tsx`, change from vertical column to horizontal bar |
| 2 | `src/tui/types.ts` | Rename `SidebarWidget` → `MidPanelWidget`, `registerSidebarWidget` → `registerMidPanelWidget` |
| 3 | `src/tui/app.tsx` | Update layout, imports, widget discovery (add `self-improvement` to known plugins) |
| 4 | `src/plugins/todo.ts` | Change `getContent()` to return summary only: `TODO: [completed] / [total]` |
| 5 | `src/plugins/self-improvement/index.ts` | Add in-memory counter + offer mid-panel widget |
| 6 | `test/tui.test.tsx` | Update tests for new layout |
| 7 | `test/todo-sidebar.test.ts` | Update tests for summary format |
| 8 | `src/tui/index.tsx` | Update ASCII art comment |

## Step-by-step

### Step 1: Rename Sidebar → MidPanel component (coder)
- Rename file `src/tui/components/Sidebar.tsx` → `src/tui/components/MidPanel.tsx`
- Change from right-column (25-char wide, `flexShrink=0`) to full-width horizontal bar
- Remove `useStdout` import and terminal width check (no longer conditional)
- Render widget sections inline horizontally — each section is a `<Text>` fragment separated by ` │ ` (pipe) spacers
- Keep `borderStyle="single"` and `borderColor={scheme.border}`
- Accept `MidPanelWidget[]` instead of `SidebarWidget[]`

### Step 2: Update types.ts (coder)
- Rename `SidebarWidget` → `MidPanelWidget`
- Rename `registerSidebarWidget` → `registerMidPanelWidget` in `DroneTuiCapability`
- Update JSDoc comments

### Step 3: Update app.tsx layout (coder)
- Import `MidPanel` instead of `Sidebar`
- Import `MidPanelWidget` instead of `SidebarWidget`
- Move `<MidPanel>` from inside the `flexDirection="row"` box to between `<ChatLog>` and `<InputLine>`
- Remove the `flexDirection="row"` wrapper (ChatLog now takes full width)
- Update `knownWidgetPluginIds` to include `'self-improvement'`
- Rename state/callbacks: `sidebarWidgets` → `midPanelWidgets`, `registerSidebarWidget` → `registerMidPanelWidget`

### Step 4: Update todo plugin (coder)
- Change `getContent()` to return a single summary line: `TODO: [completed] / [total]`
- Remove the full item list rendering (icons, truncated titles, etc.)

### Step 5: Update self-improvement plugin (coder)
- Add in-memory counter `let insightCount = 0` at module level
- Increment counter in the `insight` tool's `execute` handler after successful write
- Call `registration.offer()` with a mid-panel widget showing `Insights: [count]`

### Step 6: Update tests (tester)
- `test/tui.test.tsx`: Update Sidebar → MidPanel imports, update layout assertions
- `test/todo-sidebar.test.ts`: Update assertions for summary format (single line, no icons)
- Add test for insights widget

### Step 7: Update index.tsx ASCII art (coder)
- Update the layout diagram in `src/tui/index.tsx` to show the mid panel

## Dependencies
```
Step 1 ──┐
         ├── Step 3 ──┐
Step 2 ──┘           ├── Step 6
                     │
Step 4 ──────────────┤
                     │
Step 5 ──────────────┘
                     
Step 7 (anytime after Step 3)
```

## Design decisions (confirmed with user)
1. **Mid panel layout**: Single-line horizontal bar with ` │ ` separators between widgets
2. **Border**: Yes, keep `borderStyle="single"` with `borderColor={scheme.border}`
3. **Insights counter**: In-memory, session-only count (not persisted)

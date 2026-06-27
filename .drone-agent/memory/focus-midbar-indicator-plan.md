---
key: focus-midbar-indicator-plan
tags:
  - ui
  - mid-bar
  - focus-plugin
  - todo-plugin
  - feature-request
created: 2026-06-27T19:49:24.490Z
updated: 2026-06-27T19:49:24.490Z
---

# Plan: Add FOCUSED indicator to mid-bar

## Problem
The user wants to add a "FOCUSED" indicator in the same mid-bar where the TODO list summary is displayed, showing when the focus plugin has a focus currently set.

## Architecture Overview
- **MidPanelWidget**: Each plugin can offer a widget with `id`, `label`, and `getContent()` function returning `string[]`
- **MidPanel component**: Renders all widgets horizontally with " │ " separators
- **TODO widget**: Shows `completed/total : n WORKING` format
- **Focus plugin**: Maintains `state.currentFocus` internally

## Implementation Plan

### Step 1: Modify focus plugin (`drone-agent/src/plugins/focus.ts`)

Add an offer call after the `onPluginsLoaded` hook registration (around line 145):

```typescript
registration.offer({
  id: 'focus',
  label: 'FOCUSED',
  getContent: () => {
    if (!state.currentFocus) return [];
    return [state.currentFocus];
  },
});
```

### Expected Result
When focus is set, mid-bar displays:
```
TODO: 1/3 │ FOCUSED: Fix login bug
```

When no focus, FOCUSED widget returns empty array (hidden):
```
TODO: 1/3
```

## Files to Modify
- `/home/unleet/Projects/drone-agent/drone-agent/src/plugins/focus.ts`

## Files to Review
- `/home/unleet/Projects/drone-agent/drone-agent/src/plugins/todo.ts` (reference implementation)
- `/home/unleet/Projects/drone-agent/drone-agent/src/tui/types.ts` (MidPanelWidget type)
- `/home/unleet/Projects/drone-agent/drone-agent/src/tui/components/MidPanel.tsx` (rendering logic)
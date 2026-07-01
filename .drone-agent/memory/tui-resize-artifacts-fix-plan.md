---
key: tui-resize-artifacts-fix-plan
tags:
  []
created: 2026-07-01T23:02:01.866Z
updated: 2026-07-01T23:02:01.866Z
---

# Plan: Reduce Terminal Resize Artifacts

## Summary

The `drone-agent` TUI (built on Ink 5.2.0 + React 18) creates visual artifacts (flickering, "stamping," duplicate content) when the terminal is resized. This is caused by Ink's architecture: on every `SIGWINCH` (resize event), Ink erases all previous lines and rewrites the entire UI from scratch. When the window is dragged, dozens of resize events fire per second, each triggering a full erase-and-redraw cycle. The `previousLineCount` tracking gets out of sync, creating visible ghost lines.

This plan addresses the issue with two complementary changes:

1. **Upgrade Ink from 5.2.0 to 6.8.0 (with React 18→19)** — Getting Ink 6.x brings the PR #828 fix for UI stamping on terminal shrink, a shared resize listener (fewer duplicate re-renders per v7.0.4), and the `useWindowSize()` hook.

2. **Debounce resize handling** — Wrap Ink's built-in resize event with a debounce (120ms) so that during a window-drag gesture, only the *final* size triggers a re-render, instead of every intermediate size.

## Prerequisites / Dependencies

- React must be upgraded from `^18.3.1` to `>=19.0.0` because Ink 6.x requires React >=19
- `@types/react` must be upgraded from `^18.3.12` to `>=19.0.0`
- `ink-text-input@6.0.0` already supports `ink>=5` and `react>=18`, so it should work with the upgraded versions — no change needed
- `ink-testing-library@4.0.0` only requires `@types/react >=18`, so it should work — no change needed
- All other deps (`lowlight`, `marked`, `ollama`, `tar`, `fast-glob`) are unrelated to the TUI and need no changes

## Step-by-Step Implementation

### Step 1: Upgrade package dependencies

**File: `drone-agent/package.json`**

Change the following entries:

- `"ink": "^5.2.0"` → `"ink": "^6.8.0"`
- `"react": "^18.3.1"` → `"react": "^19.2.7"`
- `"@types/react": "^18.3.12"` → `"@types/react": "^19.2.17"`
- peer dep `"react": "^18.0.0"` → `"react": "^19.0.0"`

Then run `pnpm install`.

**Assignee:** Coder  
**Dependencies:** None  
**Validation:** `pnpm install` exits 0; `pnpm typecheck` passes

### Step 2: Audit for Ink 5→6 API breaking changes

Check:
1. **`render()` options**: Ink 6 may have dropped `exitOnCtrlC` from render options. The existing `useInput` handler in `app.tsx` already handles Ctrl+C, so we may just need to remove the `exitOnCtrlC` option from the render call in `src/tui/index.tsx`.
2. **`<Static>` component**: The `style` prop on `<Static>` may have changed in Ink 6. Check `ChatLog.tsx`.
3. **Color types**: Verify theme color strings still work with Ink 6's chalk-based type system.
4. **`useInput` behavior**: Verify existing key handlers still work.

**Assignee:** Coder  
**Dependencies:** Step 1  
**Validation:** Run the TUI and verify Ctrl+C still exits, ? still shows help, and basic layout renders correctly.

### Step 3: Create a debounced window-size hook

**New file: `drone-agent/src/tui/hooks/useDebouncedWindowSize.ts`**

Create a custom hook that wraps Ink 6's `useWindowSize()` with a debounce:

```ts
import { useWindowSize } from 'ink';
import { useEffect, useRef, useState } from 'react';

interface WindowSize {
  columns: number;
  rows: number;
}

export function useDebouncedWindowSize(debounceMs = 120): WindowSize {
  const { columns, rows } = useWindowSize();
  const [debounced, setDebounced] = useState<WindowSize>({ columns, rows });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setDebounced({ columns, rows });
    }, debounceMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [columns, rows, debounceMs]);

  return debounced;
}
```

**Assignee:** Coder  
**Dependencies:** Step 1  
**Validation:** File compiles, hook is importable.

### Step 4: Wire the debounced hook into `app.tsx`

**File: `drone-agent/src/tui/app.tsx`**

Add the import and call the hook at the component top:

```ts
import { useDebouncedWindowSize } from './hooks/useDebouncedWindowSize.js';

// Alongside other hooks:
const { columns, rows } = useDebouncedWindowSize(120);
```

The values don't need to be explicitly used — just calling the hook delays the React re-render trigger during rapid resize events. The existing `width="100%"` and `height="100%"` layout still operates on Ink's internal (immediate) dimensions.

**Assignee:** Coder  
**Dependencies:** Step 3  
**Validation:** `pnpm typecheck` passes; TUI renders correctly.

### Step 5: Run full validation

```bash
pnpm build        # Compile all packages
pnpm typecheck    # Type-check all packages
pnpm lint         # ESLint + Prettier
pnpm test         # Run all tests (vitest)
```

**Assignee:** Coder  
**Dependencies:** Steps 1–4  
**Validation:** All commands exit 0.

### Step 6: Manual TUI smoke test

Run the TUI interactively and verify:
1. The TUI renders correctly on startup
2. Typing and submitting works
3. Resizing produces no visual artifacts
4. Ctrl+C exits cleanly
5. `?` shows help
6. Slash commands still work

**Assignee:** Tester  
**Dependencies:** Step 5  
**Validation:** All manual checks pass.

## Validation Criteria

1. `pnpm build` exits 0 with no errors
2. `pnpm typecheck` passes with no type errors (including the LSP diagnostics)
3. `pnpm lint` passes with no errors
4. `pnpm test` passes
5. Manual TUI smoke test confirms:
   - Resize artifacts are eliminated or significantly reduced
   - All existing keyboard shortcuts and slash commands work
   - The TUI renders correctly at various terminal sizes
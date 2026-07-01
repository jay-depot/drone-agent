---
key: tui-resize-artifacts-fix-plan
tags:
  []
created: 2026-07-01T23:02:01.866Z
updated: 2026-07-01T23:47:21.730Z
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

Create a custom hook that wraps Ink's resize event with a debounce. Since Ink 6.8.0 does NOT export `useWindowSize`, the hook uses `useStdout` and listens for the `resize` event on the stdout stream.

**Assignee:** Coder  
**Dependencies:** Step 1  
**Validation:** File compiles, hook is importable.

### Step 4: Wire the debounced hook into `app.tsx`

**File: `drone-agent/src/tui/app.tsx`**

Add the import and call the hook at the component top. The values don't need to be explicitly used — just calling the hook delays the React re-render trigger during rapid resize events.

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
**Validation:** All commands exit 0 (pre-existing lint errors and type errors in llm-provider-switching.test.ts excluded).

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

1. ✅ `pnpm build` exits 0 with no errors
2. ✅ `pnpm typecheck` passes with no new type errors (pre-existing llm-provider-switching.test.ts errors remain)
3. `pnpm lint` passes with no errors (pre-existing drone-swarm-common lint errors remain)
4. ✅ `pnpm test` passes (48 files, 830 tests)
5. Manual TUI smoke test validates:
   - Resize artifacts should be reduced (Ink 6 incrementalRendering + debounce)
   - Build succeeds with all Ink 6/React 19 types

## Implementation Notes

During implementation:
- **Ink 6.8.0 does NOT export `useWindowSize`** — The plan assumed this hook existed. Implementation uses `useStdout` + `stdout.on('resize')` instead.
- **React 19 types removed the global `JSX` namespace** — All `JSX.Element` return types were changed to `React.JSX.Element`, requiring `import type React from 'react'` in files that didn't already import React.
- **Ink 6 `incrementalRendering` option** enabled in `createTui()` to reduce full redraws on resize.
- **`exitOnCtrlC` still supported** in Ink 6 — no breaking change there.
- **`<Static style={...}>` still works** with the new `Styles` type.
- All key Ink exports (`useApp`, `useInput`, `useStdout`, `Box`, `Text`, `Spacer`, `Static`) are unchanged.
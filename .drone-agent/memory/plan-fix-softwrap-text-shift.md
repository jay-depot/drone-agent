---
key: plan-fix-softwrap-text-shift
tags:
  - plan
  - tui
  - cursor-navigation
  - soft-wrap
  - flexbox
created: 2026-08-05T22:43:34.850Z
updated: 2026-08-05T22:43:34.850Z
---

# Plan: Fix text shift after soft-wrap in TUI input

## Status: Ready for implementation

## Problem

When typing past a soft-wrap boundary in the TUI input, the prompt label's right padding disappears and all entered text shifts 1 space left. This happens 4-6 characters after the first soft-wrap.

## Root Cause

Ink's `Box` component defaults to `flexShrink: 1`. In `InputLine`, the prompt label and LLM indicator Boxes are `<Box flexGrow={0}>` — they inherit `flexShrink: 1` from the default. The `MultilineTextInput` renders `<Text wrap="wrap">` with the cursor's inverse space appended (1 visible column). 

Ink's rendering pipeline:
1. First Yoga layout pass: `Text` node's intrinsic width is measured by `widestLine()` BEFORE wrapping runs — includes the cursor's 1 character.
2. When text + cursor exceeds the input Box's content width, Yoga sees the `Text` node is too wide.
3. Since the input Box is `flexGrow={1}` (already at max), Yoga shrinks sibling Boxes with `flexShrink={1}` — the prompt label and LLM indicator.
4. The prompt label loses 1 character (its trailing space), and all input text shifts left by 1.

This happens 4-6 characters after the first soft-wrap because that's when the cursor (now on line 1) accumulates enough text to fill line 1 and pushes the `Text` node's widest line past the input Box width again.

Key Ink internals:
- `renderNodeToOutput` (render-node-to-output.js): wraps text using `wrapText`/`wrapAnsi` at `getMaxWidth(yogaNode)` only when `widestLine(text) > maxWidth`. This happens AFTER Yoga layout, so the pre-wrap width is what Yoga sees.
- `getMaxWidth` (get-max-width.js): `computedWidth - paddingLeft - paddingRight - borderLeft - borderRight`
- `Box` default styles (Box.js): `flexShrink: 1` is inherited by ALL Boxes unless overridden.

## Fix

### Step 1: Prevent sibling shrinkage
**File:** `drone-agent/src/tui/components/InputLine.tsx`

Add `flexShrink={0}` to the LLM indicator Box and the prompt label Box to prevent Yoga from shrinking them when the Text node's pre-wrap width exceeds the input Box's content width.

Add `overflow="hidden"` to the input content Box (the one with `flexGrow={1}`) to clip any Text overflow rather than letting it push siblings.

```tsx
<Box flexGrow={0} flexShrink={0}>
  {llmFrame ? <Text color={llmColor}>{llmFrame} </Text> : null}
</Box>
<Box flexGrow={0} flexShrink={0}>
  {promptLabel ? (
    <Text color={scheme.userInput}>{promptLabel}</Text>
  ) : null}
</Box>
<Box flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="column">
  <MultilineTextInput ... />
</Box>
```

### Step 2: Add regression test
**File:** `drone-agent/test/multiline-text-input.test.tsx`

Add a test that renders `InputLineShell` with text long enough to trigger a soft-wrap, and verifies the prompt label's trailing space is preserved (i.e., the prompt label text is not truncated). The test should check that the rendered output contains the full prompt label string including its trailing space, even when the input text exceeds the available width.

### Step 3: Validation

- `pnpm -r run typecheck` passes with zero errors (excluding pre-existing `useSgrMouse.test.tsx` mock type issues)
- `pnpm -r run build` passes
- `pnpm -r run lint` passes
- `pnpm -r run test` passes
- All LSP diagnostics for modified files are clean

## Context

This is part of a broader fix session for cursor navigation in the TUI. Previous fixes in this session:
1. Removed `useSgrMouse` hook (incompatible with Ink's readable-mode stdin) — SGR mouse sequences now filtered in `MultilineTextInput`'s `useInput` handler
2. Fixed effective text width calculation in `InputLine` (terminal width minus border, padding, LLM indicator, and prompt label)
3. Removed mouse click-to-position (not enough precision without terminal row mapping)

Branch: `feat/better-cursor-nav`
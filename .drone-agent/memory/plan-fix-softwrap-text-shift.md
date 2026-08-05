---
key: plan-fix-softwrap-text-shift
tags:
  - plan
  - tui
  - cursor-navigation
  - soft-wrap
  - flexbox
created: 2026-08-05T22:43:34.850Z
updated: 2026-08-05T22:53:46.114Z
---

# Plan: Fix text shift after soft-wrap in TUI input

## Status: COMPLETED

## Problem

When typing past a soft-wrap boundary in the TUI input, the prompt label's right padding disappeared and all entered text shifted 1 space left. This happened 4-6 characters after the first soft-wrap.

## Root Cause

Ink's `Box` component defaults to `flexShrink: 1`. In `InputLine`, the prompt label and LLM indicator Boxes were `<Box flexGrow={0}>` — they inherited `flexShrink: 1` from the default. The `MultilineTextInput` renders `<Text wrap="wrap">` with the cursor's inverse space appended (1 visible column).

Ink's rendering pipeline:
1. First Yoga layout pass: `Text` node's intrinsic width is measured by `widestLine()` BEFORE wrapping runs — includes the cursor's 1 character.
2. When text + cursor exceeds the input Box's content width, Yoga sees the `Text` node is too wide.
3. Since the input Box is `flexGrow={1}` (already at max), Yoga shrinks sibling Boxes with `flexShrink={1}` — the prompt label and LLM indicator.
4. The prompt label loses 1 character (its trailing space), and all input text shifts left by 1.

Key Ink internals:
- `renderNodeToOutput` (render-node-to-output.js): wraps text using `wrapText`/`wrapAnsi` at `getMaxWidth(yogaNode)` only when `widestLine(text) > maxWidth`. This happens AFTER Yoga layout, so the pre-wrap width is what Yoga sees.
- `getMaxWidth` (get-max-width.js): `computedWidth - paddingLeft - paddingRight - borderLeft - borderRight`
- `Box` default styles (Box.js): `flexShrink: 1` is inherited by ALL Boxes unless overridden.

## Fix (Completed)

### Step 1: Prevent sibling shrinkage ✅
**File:** `drone-agent/src/tui/components/InputLine.tsx`

Added `flexShrink={0}` to the LLM indicator Box and the prompt label Box to prevent Yoga from shrinking them when the Text node's pre-wrap width exceeds the input Box's content width.

Added `overflow="hidden"` to the input content Box (the one with `flexGrow={1}`) to clip any Text overflow rather than letting it push siblings.

### Step 2: Add regression test ✅
**File:** `drone-agent/test/multiline-text-input.test.tsx`

Updated the `InputLineShell` test harness to match the fixed layout (with `flexShrink={0}` on the label Box and `overflow="hidden"` on the content Box). Added a regression test that renders with 25 chars of input at an effective text width of 19, verifying:
- The full prompt label `'drone> '` (including trailing space) is preserved in the output
- The text wraps to multiple lines

### Step 3: Validation ✅
- `pnpm -r run typecheck` passes (excluding pre-existing `useSgrMouse.test.tsx` mock type issues)
- `pnpm -r run build` passes
- `pnpm lint` passes (prettier reformatted the test file)
- `pnpm -r run test` passes (110 files, 1735 tests, 9 skipped)
- LSP diagnostics clean for modified files

## Commit
`7f523f7` on branch `feat/better-cursor-nav`

## Context

This is part of a broader fix session for cursor navigation in the TUI. Previous fixes in this session:
1. Removed `useSgrMouse` hook (incompatible with Ink's readable-mode stdin) — SGR mouse sequences now filtered in `MultilineTextInput`'s `useInput` handler
2. Fixed effective text width calculation in `InputLine` (terminal width minus border, padding, LLM indicator, and prompt label)
3. Removed mouse click-to-position (not enough precision without terminal row mapping)

Branch: `feat/better-cursor-nav`
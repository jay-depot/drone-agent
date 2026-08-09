---
key: plan-fix-cursor-end-of-line
tags:
  - plan
  - tui
  - cursor
  - multiline
created: 2026-08-05T23:05:37.578Z
updated: 2026-08-09T01:39:10.587Z
---

# Plan: Fix invisible cursor at end of non-last lines in MultilineTextInput

## Status: COMPLETED

## Problem

When the cursor was at the end of any line except the last (i.e., positioned just before a `\n` character), it disappeared. The cursor was visible at all other positions, including the end of the last line.

## Root Cause

In `renderWithCursor` (`MultilineTextInput.tsx`), the cursor was rendered by inverting the character at the cursor offset:

```js
const at = text[clamped] ?? '';
const cursor = at ? `\u001b[7m${at}\u001b[27m` : '\u001b[7m \u001b[27m';
```

When `at` was `\n`, the result was `\u001b[7m\n\u001b[27m`. The `\n` caused a line break before the inverse video took effect, so nothing was visibly inverted. The `\u001b[27m` (inverse off) ended up on the next line with no visible effect.

When `at` was `undefined` (end of text), the fallback `\u001b[7m \u001b[27m` (inverse space) rendered correctly — which is why the end of the last line worked.

## Fix (Completed)

### Step 1: Fix renderWithCursor ✅
**File:** `drone-agent/src/tui/components/MultilineTextInput.tsx`

Changed `renderWithCursor` to handle the `\n` case specially — render an inverse space before the newline instead of inverting the newline character:

```js
const at = text[clamped] ?? '';

let cursor: string;
if (!at) {
  // End of text: inverse space cursor
  cursor = '\u001b[7m \u001b[27m';
} else if (at === '\n') {
  // Cursor is at a newline (end of a non-last line):
  // show inverse space before the line break
  cursor = '\u001b[7m \u001b[27m\n';
} else {
  // Normal: invert the character at the cursor
  cursor = `\u001b[7m${at}\u001b[27m`;
}

return before + cursor + after;
```

The `\n` is included in the cursor string, and `after = text.slice(clamped + 1)` correctly skips it (since `clamped + 1` is past the `\n`). The rendered output for `"hello\nworld"` with cursor at offset 5 is:

```
hello\u001b[7m \u001b[27m\nworld
```

### Step 2: Add regression test ✅
**File:** `drone-agent/test/multiline-text-input.test.tsx`

Added test `renders cursor at end of a non-last line`:
- Renders `{'hello\nworld'}` (using JSX expression so `\n` is a real newline, not literal backslash-n)
- Sends 6 left-arrow escape sequences (`\u001B[D`) one at a time with a tick between each (important: all-at-once batches in React read stale cursorOffset and only move 1 position)
- Asserts the inverse escape `\u001b[7m` appears on the "hello" line, not on the "world" line

### Step 3: Validation ✅
- `pnpm -r run typecheck` passes (excluding pre-existing `useSgrMouse.test.tsx` mock type issues)
- `pnpm -r run build` passes
- `pnpm lint` passes
- `pnpm -r run test` passes (110 files, 1736 tests, 9 skipped)
- LSP diagnostics clean for modified files

## Commit
`c29ad18` on branch `feat/better-cursor-nav`

## Context

This is part of a broader fix session for cursor navigation in the TUI. Prior fixes:
1. Removed `useSgrMouse` hook (incompatible with Ink's readable-mode stdin) — SGR mouse sequences filtered in `MultilineTextInput`'s `useInput`
2. Fixed effective text width calculation in `InputLine`
3. Removed mouse click-to-position
4. Fixed prompt label shrinkage after soft-wrap (flexShrink={0} + overflow="hidden")

## Notes for future work
- ink-testing-library's `Stdin.write` overwrites `this.data` on each call; multiple keypresses must be sent one at a time with a tick between each, otherwise React batches them and they all read the stale cursorOffset.
- JSX string literals treat `\n` as literal backslash-n; use `{'...\n...'}` for real newlines.
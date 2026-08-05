---
key: plan-fix-cursor-end-of-line
tags:
  - plan
  - tui
  - cursor
  - multiline
created: 2026-08-05T23:05:37.578Z
updated: 2026-08-05T23:05:37.578Z
---

# Plan: Fix invisible cursor at end of non-last lines in MultilineTextInput

## Status: Ready for implementation

## Problem

When the cursor is at the end of any line except the last (i.e., positioned just before a `\n` character), it disappears. The cursor is visible at all other positions, including the end of the last line.

## Root Cause

In `renderWithCursor` (`MultilineTextInput.tsx`), the cursor is rendered by inverting the character at the cursor offset:

```js
const at = text[clamped] ?? '';
const cursor = at ? `\u001b[7m${at}\u001b[27m` : '\u001b[7m \u001b[27m';
```

When `at` is `\n`, the result is `\u001b[7m\n\u001b[27m`. The `\n` causes a line break before the inverse video takes effect, so nothing is visibly inverted. The `\u001b[27m` (inverse off) ends up on the next line with no visible effect.

When `at` is `undefined` (end of text), the fallback `\u001b[7m \u001b[27m` (inverse space) renders correctly — which is why the end of the last line works.

## Fix

**File:** `drone-agent/src/tui/components/MultilineTextInput.tsx`

In `renderWithCursor`, handle the `\n` case specially — render an inverse space before the newline instead of inverting the newline character:

```js
const at = text[clamped] ?? '';

let cursor: string;
if (!at) {
  // End of text: inverse space cursor
  cursor = '\u001b[7m \u001b[27m';
} else if (at === '\n') {
  // Cursor is at a newline (end of non-last line):
  // show inverse space before the line break
  cursor = '\u001b[7m \u001b[27m\n';
} else {
  // Normal: invert the character at the cursor
  cursor = `\u001b[7m${at}\u001b[27m`;
}

return before + cursor + after;
```

The `\n` is included in the cursor string, and `after = text.slice(clamped + 1)` correctly skips it (since `clamped + 1` is past the `\n`). The rendered output for `"hello\nworld"` with cursor at offset 5 would be:

```
hello\u001b[7m \u001b[27m\nworld
```

## Tests

**File:** `drone-agent/test/multiline-text-input.test.tsx`

Add a test that renders multi-line text (e.g., `"hello\nworld"`) with the cursor at the end of the first line (offset 5), and verifies the inverse escape code (`\u001b[7m`) appears on the same line as "hello", not on the "world" line.

## Validation criteria

- `pnpm -r run typecheck` passes with zero errors (excluding pre-existing `useSgrMouse.test.tsx` mock type issues)
- `pnpm -r run build` passes
- `pnpm lint` passes
- `pnpm -r run test` passes
- All LSP diagnostics for modified files are clean
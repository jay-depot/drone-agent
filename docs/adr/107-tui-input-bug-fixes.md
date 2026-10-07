---
tags: [decision, tui, input, cursor]
related: [drone-agent-tui.md, 106-cursor-navigation-visual-line-model.md, 099-tui-paste-handling.md]
---

# ADR 107: TUI Input Bug Fixes — Mouse Nav Removal, Soft-Wrap Shift, Cursor End-of-Line

**Status**: Implemented (commits `189693a`, `7f523f7`, `c29ad18` on branch `feat/better-cursor-nav`)

## Context

After the enhanced cursor navigation in [106-cursor-navigation-visual-line-model](106-cursor-navigation-visual-line-model.md), several bugs surfaced in the TUI input (`MultilineTextInput`, `InputLine`, `ElicitationPrompt`, `app.tsx`):

1. **Mouse clicks dumped control characters into the text** — clicking dumped sequences like `[<0;17;59M[<0;17;59m...` into the text entry instead of positioning the cursor. Scroll wheel events were also caught, and native text selection stopped working.
2. **Vertical navigation was off across soft-wraps** — Up/Down navigation landed on the wrong visual line.
3. **Soft-wrap text shift** — typing past a soft-wrap boundary (4-6 chars after) caused the persona-name prompt's 1-space right padding to disappear; all entered text shifted one space left.
4. **Cursor invisible at end of non-last lines** — with multi-line input, the cursor disappeared when at the end of any line except the last.

## Root Causes and Decisions

### 1. Mouse nav didn't work with Ink's readable-mode stdin → removed

The original `useSgrMouse` hook listened on `process.stdin.on('data', ...)`, but Ink uses `readable`-mode stdin, so `data` events never fire. Instead, Ink's `inputParser` sees SGR mouse sequences (`\x1b[<row;col;buttonM`) — where `<` (0x3c) is a CSI parameter byte — as valid CSI sequences and emits them as `input` events. `MultilineTextInput`'s `useInput` fell through to the printable-character handler and inserted the raw escape sequence into the text.

**Decision**: Remove mouse click-to-position entirely (it was only ever approximate, since Ink doesn't expose component positions for precise row→visual-line mapping). Restore native text selection by not capturing mouse input. Keep a simple guard in `MultilineTextInput`'s `useInput` that filters out any input starting with `[<` (SGR sequences) so they never reach the text.

### 2. Vertical nav off across soft-wraps → corrected effective text width

The `columns` prop passed to `MultilineTextInput` was the full terminal width, but the actual text area is narrower (border, padding, LLM indicator, prompt label). The visual-text-model therefore computed wrap points at the wrong width, so Up/Down landed on the wrong visual line.

**Decision**: `InputLine` now computes the effective text width as `terminalWidth - 4 (border + paddingX) - llmIndicatorWidth - promptLabelWidth` and passes that to `MultilineTextInput` as `columns`.

### 3. Soft-wrap text shift → Ink `flexShrink` + cursor width

Ink's `Box` defaults to `flexShrink: 1`. In `InputLine`, the prompt label and LLM indicator Boxes (`flexGrow={0}`) inherited `flexShrink: 1`. The `Text` node's intrinsic width — measured by `widestLine()` BEFORE wrapping, and including the cursor's 1-column inverse space — could exceed the input Box's content width. Since the input Box is `flexGrow={1}` (already at max), Yoga shrank the sibling label Boxes, eating the prompt label's trailing space and shifting all text left by one.

**Decision**: Add `flexShrink={0}` to the LLM indicator and prompt label Boxes so Yoga never shrinks them, and add `overflow="hidden"` to the input content Box so any Text overflow is clipped rather than pushing siblings.

### 4. Cursor invisible at end of non-last lines → special-case `\n`

`renderWithCursor` inverted the character at the cursor offset. When that character was `\n`, the output was `\u001b[7m\n\u001b[27m` — but the line break happens before the inverse video takes effect, so nothing was visibly inverted. At end-of-text (`undefined`), the inverse-space fallback (`\u001b[7m \u001b[27m`) worked, which is why the end of the last line was fine.

**Decision**: When the character at the cursor is `\n`, render an inverse space *before* the line break: `\u001b[7m \u001b[27m\n`. This matches the end-of-text case and keeps the cursor visible on the correct line.

## Consequences

### Positive

- Native text selection works again; no garbage dumped into the input
- Up/Down navigation is correct across soft-wraps
- Prompt label padding stays stable after soft-wrap
- Cursor is visible at the end of every line

### Negative

- Mouse click-to-position is gone (was approximate and broken anyway)
- `useSgrMouse.ts` and `useSgrMouse.test.tsx` remain as dead code (not imported by `src/`)

### Neutral

- `columns` is now the effective text width (terminal minus decorations), computed in `InputLine`
- The `[<` guard in `useInput` is a small, focused filter

## Files Changed

| File | Change |
|------|--------|
| `src/tui/components/MultilineTextInput.tsx` | Removed mouse click handling; added `[<` SGR filter; fixed `renderWithCursor` for `\n` (inverse space before line break) |
| `src/tui/components/InputLine.tsx` | Removed `mouseClick` prop; compute effective `textWidth`; added `flexShrink={0}` to label Boxes + `overflow="hidden"` to input Box |
| `src/tui/components/ElicitationPrompt.tsx` | Removed `mouseClick` prop and `SgrMouseEvent` import |
| `src/tui/app.tsx` | Removed `useSgrMouse` import and `lastClick` wiring |
| `test/multiline-text-input.test.tsx` | Added `columns` to test shell; added regression tests for prompt label preservation after soft-wrap and cursor at end of non-last line |

## Related

- [drone-agent-tui](../../drone-agent/src/tui/) — The TUI module
- [106-cursor-navigation-visual-line-model](106-cursor-navigation-visual-line-model.md) — The original cursor navigation ADR (mouse support added then removed)
- [099-tui-paste-handling](099-tui-paste-handling.md) — Paste handling (shared `useBracketedPaste` hook)

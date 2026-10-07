---
tags: [decision, tui, input, cursor]
related: [drone-agent-tui.md, 099-tui-paste-handling.md, 107-tui-input-bug-fixes.md]
---

# ADR 106: Enhanced Cursor Navigation with Visual Line Model

**Status**: Implemented (commit `58d3d78` on branch `feat/better-cursor-nav`); **merged to `main`** (commit `13e2ac3`, PR #38); **mouse click-to-position later removed** (commit `189693a`)

## Context

The TUI's `MultilineTextInput` component only supported Left/Right arrow navigation. Users composing multi-line messages (Ctrl+J) had no way to navigate back to earlier lines without deleting and retyping. The missing keys were: Up/Down arrows, Home/End, Ctrl+Left/Right word-jump, Ctrl+U/K line kill, and mouse click-to-position.

Additionally, the `FreeformInput` component in `ElicitationPrompt.tsx` was a simpler append-only input with no cursor navigation at all.

## Decision

### 1. Visual line model with word-wrap awareness

Created a pure, testable module `src/tui/shared/visual-text-model.ts` (no React dependencies) that models text as visual lines with word-wrap awareness. The algorithm:

1. Split text on `\n` to get logical lines
2. For each logical line, split into words (non-whitespace segments)
3. Pack words into visual lines: if adding a word would exceed `width`, start a new visual line
4. Trailing whitespace at the end of a visual line is dropped (matches terminal rendering)
5. Leading whitespace at the start of a new visual line is skipped
6. If a single word exceeds `width`, character-wrap it (split at `width` boundary)
7. Empty logical lines (including trailing `\n`) produce a single empty visual line

Exports: `computeVisualLines`, `offsetToVisual`, `visualToOffset`, `findLineStart`, `findLineEnd`, `findWordStart`, `findWordEnd`.

### 2. Preferred column tracking for Up/Down

A `preferredColumn` ref stores the visual column when the user presses Up/Down. On subsequent vertical movement, the preferred column is used instead of the new line's actual column. Reset to `null` on any horizontal movement (Left/Right, typing, paste, mouse click).

### 3. SGR mouse mode 1000 (not 1002) — initially added, later removed

Created `src/tui/hooks/useSgrMouse.ts` which enabled SGR mouse mode 1000 + 1006 on mount and disabled on unmount. Mode 1000 reported button press/release events only. Mode 1002 (drag events) was deliberately NOT enabled, preserving native text selection via drag in the terminal.

Mouse click events were parsed from stdin data events matching the regex `^\x1b\[<(\d+);(\d+);(\d+)([Mm])`. The hook returned `{ lastClick }` state which was passed as a prop to `MultilineTextInput` and processed in a `useEffect`.

**This mouse support was removed** in commit `189693a`. See [[107-tui-input-bug-fixes]] for the full rationale. Summary of why it was removed:

- **Mouse click positioning was too imprecise** — Ink doesn't expose component positions, so the click row could only be heuristically mapped to a visual line. The result was approximate and barely useful.
- **SGR sequences leaked into the input text** — the `data`-event listener never fired because Ink uses `readable` mode on stdin; instead Ink's `inputParser` treated the SGR sequences (`\x1b[<row;col;buttonM`) as valid CSI sequences and emitted them as `input` events, which fell through to the printable-character handler and inserted raw escape sequences into the text.
- **Native text selection was broken** — capturing all mouse input prevented terminal-native drag-to-select.
- **Scroll wheel events** were also caught and dumped into the text.

### 4. Replace FreeformInput with MultilineTextInput

The `FreeformInput` component in `ElicitationPrompt.tsx` was removed entirely and replaced with `MultilineTextInput`. The freeform elicitation input now has full cursor navigation, paste handling, and (initially) mouse click support.

### 5. New keybindings

| Key | Action |
|---|---|
| Up arrow | Move cursor up one visual line (preferred column tracking) |
| Down arrow | Move cursor down one visual line (preferred column tracking) |
| Home | Move cursor to start of logical line |
| End | Move cursor to end of logical line |
| Ctrl+Left | Move cursor to start of previous word |
| Ctrl+Right | Move cursor to start of next word |
| Ctrl+U | Delete from cursor to start of logical line |
| Ctrl+K | Delete from cursor to end of logical line |

## Consequences

### Positive

- Full keyboard navigation in the input, matching standard text editor conventions
- Word-wrap aware visual line navigation (not just logical lines)
- Freeform elicitation inputs now have the same navigation capabilities
- Visual line model can be reused for other purposes (e.g., fixing the soft-wrap rendering glitch)
- After removing mouse support, native text selection works correctly and no garbage is inserted into input

### Negative

- **Removed**: mouse click-to-position — the implementation was approximate (no precise screen position tracking) and caused SGR escape sequences to leak into the input, breaking native text selection. See [[107-tui-input-bug-fixes]].
- The visual line model adds complexity to what was a simple flat-offset cursor

### Neutral

- `columns` prop is now required on `MultilineTextInput` (terminal width from `useDebouncedWindowSize`), adjusted in `InputLine` to account for border/padding/label widths
- `useSgrMouse.ts` remains as dead code (no longer imported by `src/`)

## Test Coverage

- `visual-text-model.test.ts` — 34 tests covering empty string, single line, wrapping, multiple logical lines, character-wrap fallback, coordinate round-trips, word/line boundaries
- `useSgrMouse.test.tsx` — 6 tests covering enable sequence, left/middle/right button parsing, partial sequences, no-op on non-TTY (file remains; hook is no longer wired into the app)
- `multiline-text-input.test.tsx` — 24 tests (13 existing + 11 new) covering all new keybindings and preferred column tracking

## Files Changed

| File | Change |
|------|--------|
| `src/tui/shared/visual-text-model.ts` | **New** — pure visual line computation module |
| `src/tui/hooks/useSgrMouse.ts` | **New** — SGR mouse mode hook (later de-wired from the app) |
| `src/tui/components/MultilineTextInput.tsx` | Modified — added all new keybindings, preferred column tracking; later removed mouse click handling and added SGR sequence filtering in `useInput` |
| `src/tui/components/InputLine.tsx` | Modified — threads `columns` prop, computes effective text width; later removed `mouseClick` prop |
| `src/tui/components/ElicitationPrompt.tsx` | Modified — replaced `FreeformInput` with `MultilineTextInput`; later removed `mouseClick` prop |
| `src/tui/app.tsx` | Modified — wired `useSgrMouse` and `useDebouncedWindowSize` columns; later removed `useSgrMouse` |
| `test/visual-text-model.test.ts` | **New** — 34 tests |
| `test/useSgrMouse.test.tsx` | **New** — 6 tests |
| `test/multiline-text-input.test.tsx` | Modified — new tests |

## Related

- [[drone-agent-tui]] — The TUI module
- [[099-tui-paste-handling]] — Paste handling (uses same `useBracketedPaste` hook)
- [[107-tui-input-bug-fixes]] — Follow-up bug fixes: removed mouse nav, fixed soft-wrap text shift, fixed cursor at end of non-last lines

---
key: tui-bugs-and-annoyances
tags:
  - tui
  - bugs
  - ux
  - input
  - markdown
  - syntax-highlighting
created: 2026-07-14T17:33:56.135Z
updated: 2026-08-03T21:17:49.449Z
---

# TUI Bugs & Minor Annoyances

A running log of non-critical TUI issues that degrade the user experience but don't prevent the agent from functioning. These are tracked here so they can be addressed in a batch fix session.

---

## Issue 1: Pasting text into the TUI is broken

**Severity:** Medium
**Area:** `MultilineTextInput` (`drone-agent/src/tui/components/MultilineTextInput.tsx`), `FreeformInput` (`drone-agent/src/tui/components/ElicitationPrompt.tsx`)

**Symptoms:**

- Pasted text gets visually mangled (newlines inserted in wrong places, cursor jumps)
- Large pastes lose parts of the text block

**Root cause:**
There is no explicit paste handling. The TUI relies entirely on the terminal emulator's bracketed paste mode, which delivers pasted characters as a rapid sequence of individual keystrokes. Each character triggers a separate `useInput` callback, which calls `onChange` → React state update. For large pastes (e.g., 10K+ characters), this causes 10K+ sequential re-renders. The visual mangling likely stems from Ink's Yoga layout recalculating on every keystroke while the paste is still in-flight, causing cursor position and line-wrapping to glitch.

Additionally, `FreeformInput` in `ElicitationPrompt.tsx` has the same problem — it appends characters one at a time with no buffering.

**Potential fixes:**

1. Buffer incoming characters in a ref and flush to state on a short debounce (e.g., 50ms of no input = paste complete)
2. Use the `data` event from `stdin` directly to detect paste boundaries (bracketed paste sequences `\e[200~` ... `\e[201~`)
3. For `FreeformInput`, replace with `MultilineTextInput` or add the same buffering logic

**Note:** `useBracketedPaste` hook was added to address this. `FreeformInput` has been replaced with `MultilineTextInput` (which uses `useBracketedPaste`). The paste handling should now work correctly.

---

## Issue 2: Syntax-highlighted code blocks are unreadable

**Status:** Fixed.
**Severity:** Medium
**Area:** `Markdown.tsx` (`drone-agent/src/tui/components/Markdown.tsx`), specifically `renderHighlightedTree()`

**Symptoms:**

- Colors aren't applied properly (only background shows)
- Where every color change should be, a newline is inserted instead
- The code block becomes a vertical stack of single words/characters

**Root cause:**
In `renderHighlightedTree()` (lines 330-367), each syntax token is rendered as a separate nested `<Text>` element:

```tsx
<Text key={lineIndex} backgroundColor={backgroundColor}>
  {line.children.map((token, tokenIndex) => {
    const color = SYNTAX_COLORS[token.type] || 'white';
    return (
      <Text key={tokenIndex} color={color}>
        {token.value}
      </Text>
    );
  })}
</Text>
```

In Ink, nested `<Text>` elements create separate Yoga layout nodes. When these nodes have different `color` props, Ink renders them as separate text runs. The Yoga layout engine miscalculates the inline flow, inserting line breaks between tokens that should be on the same line. This is the same class of bug that the cursor rendering in `MultilineTextInput` works around by using raw ANSI escape codes instead of nested `<Text inverse>` elements.

**Proposed fix:**
Render each line as a single `<Text>` element with raw ANSI escape codes for color changes (same pattern as `renderWithCursor()` in `MultilineTextInput.tsx`). This avoids the Yoga nested-Text layout bug entirely.

**Known limitation:** ANSI escape codes reset on soft line wraps. If a code line is long enough to wrap, the wrapped portion loses its color context and falls back to the terminal default color. This is a cosmetic issue that only affects very long lines. The background color still provides visual grouping. This is far better than the current behavior (spurious newlines between every token, making code blocks unreadable).

---

## Issue 3: Input cursor navigation is too limited

**Status:** Fixed (commit 58d3d78).
**Severity:** Low → Fixed
**Area:** `MultilineTextInput` (`drone-agent/src/tui/components/MultilineTextInput.tsx`), `FreeformInput` (`drone-agent/src/tui/components/ElicitationPrompt.tsx`)

**Symptoms:**

- No Up/Down arrow navigation (only Left/Right)
- No Home/End key support
- No Ctrl+Left/Ctrl+Right for word-jump
- No Ctrl+U/Ctrl+K for line kill (FreeformInput has Ctrl+U but MultilineTextInput doesn't)

**Fix implemented:**

- Up/Down arrows navigate visual lines with preferred column tracking
- Home/End jump to logical line boundaries
- Ctrl+Left/Right jump words
- Ctrl+U/K kill to start/end of logical line
- Mouse click positions cursor (SGR mode 1000, not 1002 — drag-to-select preserved)
- `FreeformInput` replaced with `MultilineTextInput` (full navigation in elicitation prompts)
- New `visual-text-model.ts` module provides word-wrap aware visual line computation
- New `useSgrMouse.ts` hook for SGR mouse mode

---

## Priority Order (for a batch fix)

1. ~~**Syntax highlighting** (Issue 2) — most visible, makes code responses actively hard to read~~ (Fixed)
2. **Paste handling** (Issue 1) — functional regression for anyone pasting code/config
3. ~~**Cursor navigation** (Issue 3) — quality-of-life improvement, lower impact~~ (Fixed)

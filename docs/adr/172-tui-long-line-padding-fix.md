---
tags: [decision, tui, syntax-highlighting, rendering]
related: [modules/drone-agent-tui.md, decisions/163-tui-markdown-color-collision-fix.md, decisions/077-tui-syntax-highlighting-ansi-escape-codes.md]
---

# 172: TUI long-line padding fix (ceil(L/W)·W width mode)

**Status**: Implemented (2026-08-29)

## Context

`renderHighlightedTree` (in `drone-agent/src/tui/shared/syntax-highlight.ts`) pads every highlighted code line with trailing spaces so the `backgroundColor` fills the code band uniformly. The original implementation padded each line to the **longest visible line's width** (`maxWidth`). On files with long prose lines (e.g. `file__read` of an Obsidian wiki page), this produced two rendering artifacts:

1. **Wrap-spill bars** — a long line soft-wraps, and its final wrapped row is a full-width run of background-only spaces with no text. On a prose-heavy file this reads as opaque "redaction bars" across the preview.
2. **Solid bars for short/blank lines** — short and blank lines were padded to the longest line's width, so they became mostly-empty dark rectangles.

## Decision

Add an optional `width` parameter to `renderHighlightedTree`. When provided (the container's available content width in terminal columns), each line pads to `ceil(L / W) · W` where `L` is the line's visible length and `W` is the width. This is a single formula with no branches that yields three desired behaviors:

- **Long lines** soft-wrap into exactly `ceil(L/W)` rows, every one fully background-filled — the padding lands *inside* the last wrapped row, so there is no bare spill band.
- **Short lines** fill exactly one full-width row.
- **Blank lines** pad to one full-width row so they stay visible as a background band (zero-width text is dropped by ink's output writer, which would otherwise make them vanish).

When `width` is `undefined` or non-positive, the function falls back to the legacy `maxWidth` mode (unchanged behavior, still covered by tests).

### Width plumbing

Ink offers no container-width measurement, so the width is **deterministic arithmetic**: each caller subtracts its own chrome. This convention is documented in `renderHighlightedTree`'s jsdoc.

- **`ToolRenderState`** (drone-core `session-types.ts`) gained an optional `columns?: number` field — a TUI-only field, same precedent as `scheme`/`syntaxColors`.
- **`app.tsx`** populates `columns` at all three `customRender({...})` invocation sites (toolProgress, toolCallBatch, toolResultBatch) via a `columnsRef` mirroring the existing `syntaxColorsRef` pattern (event handlers live in effect closures → stale-debounce risk), sourced from the existing `useDebouncedWindowSize(120)`.
- **`FileReadBlock`** passes `state.columns` straight through (no container chrome → width = terminal columns).
- **`Markdown`** reads `stdout.columns` via `useStdout` (safe: Markdown is only ever element-instantiated) with an optional `columns` prop as an explicit override/test seam; `renderCodeBlock` subtracts the code box's own chrome (border 2 + paddingX 2 → width = columns − 4).

### Empirical verification

The formula's correctness depends on Ink's wrap behavior. Verified against Ink 6.8.0's `wrap-ansi` (`{trim: false, hard: true}`):

- A row of **exactly W** visible columns does **not** wrap (wrapping is strictly `> W`) — so no `W−1` constant is needed.
- Hard-break lines wrap into exactly `ceil(L/W)` fully-filled rows.
- **Known accepted edge**: wordy lines with tokens longer than W wrap at word boundaries, so the last row can be short but is always *text-bearing* (a ragged edge, never a text-free band — strictly better than the legacy spill).

Ink-premise **canary tests** were added so a future Ink upgrade that changes the exactly-W behavior fails loudly.

### Bare-fence plain-text fallback (made intentional)

While testing, it was discovered that bare ` ``` ` fences carry an empty `lang` from `marked`, which made `lowlight.highlight('')` throw and the catch silently render unstyled text — correct observable behavior by accident. Per user decision, the behavior was kept (plain text, no lang label) but made **intentional**: `renderCodeBlock` now branches explicitly on empty lang before the try/catch, which is retained for genuinely unexpected highlight failures. A test pins the path (white text, no background run, no label).

## Key Points

- `renderHighlightedTree(tree, backgroundColor, colors?, width?)` — width mode pads to `ceil(L/W)·W`; legacy `maxWidth` mode is the fallback.
- Width is deterministic arithmetic (each container subtracts its own chrome), not measurement — documented convention.
- Blank lines render as a full-width background band (they would otherwise vanish — ink drops zero-width text).
- Exactly-W does not wrap in Ink 6.8.0; canary tests guard this premise.
- Bare fences render as plain text by design, not by lowlight throwing.

## Related

- [drone-agent-tui](../../drone-agent/src/tui/) — the TUI module page (syntax highlighting section)
- [163-tui-markdown-color-collision-fix](163-tui-markdown-color-collision-fix.md) — the prior SyntaxStyle/SyntaxTheme collision fix that this builds on
- [077-tui-syntax-highlighting-ansi-escape-codes](077-tui-syntax-highlighting-ansi-escape-codes.md) — the original ANSI-escape rendering approach

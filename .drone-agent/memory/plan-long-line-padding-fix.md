---
key: plan-long-line-padding-fix
tags:
  []
created: 2026-08-29T01:59:59.107Z
updated: 2026-08-29T01:59:59.107Z
---

# Plan: Long-line padding fix for renderHighlightedTree (TUI code-band rendering)

## Summary
`renderHighlightedTree` (drone-agent/src/tui/shared/syntax-highlight.ts) pads every highlighted code line to the preview's longest visible line (`maxWidth`) and gives each `<Text>` a background. Consequences: (a) long lines soft-wrap and their final wrapped row is a full-width bare background band (reads as opaque "redaction bars" — observed on file__read of Obsidian wiki pages with long prose lines); (b) blank/short lines become solid bars. Fix: pad each line to `ceil(L / W) * W` (W = available width). Long lines wrap into exactly `ceil(L/W)` fully-filled rows; blank lines pad to 0 (true empty rows); short lines fill one row. One formula, no branches.

Scope notes (confirmed during planning):
- The 10-line preview cap in FileReadBlock is INTENDED display truncation. No change.
- Markdown nested containers (blockquote/list) flatten nested code to raw text today — they never reach renderHighlightedTree. Only top-level code boxes do; their Box chrome is border(2)+paddingX(2) → content width = columns − 4. FileReadBlock has no chrome → width = columns.
- Ink offers no container-width measurement; width is deterministic arithmetic (each container subtracts its own chrome). Document this convention in renderHighlightedTree's jsdoc.

## Steps

1. **[coder] Extend ToolRenderState** — drone-core/src/session-types.ts (~line 131): add optional `columns?: number` (TUI-only field, same precedent as `scheme`/`syntaxColors`). Then `pnpm -r run build` so dependent packages see the new dist types.

2. **[coder] Add width parameter to renderHighlightedTree** — drone-agent/src/tui/shared/syntax-highlight.ts (line ~276): signature becomes `(tree, backgroundColor, colors?, width?)`. Per line: `padTarget = width && width > 0 ? Math.ceil(L / width) * width : maxWidth` (legacy fallback when width undefined/nonsensical). Javadoc: formula rationale (exact wrap-row count; blanks pad to 0), the container-subtraction convention, and legacy fallback.

3. **[tester] Empirical wrap check + test rewrite** — drone-agent/test/syntax-highlight.test.ts: (a) verify via an actual ink render at known width that a row of exactly W visible columns does NOT wrap (ink wrap is strictly >W). If it does wrap, adjust to use W−1 in the formula (single constant). (b) Rewrite the two pad-to-maxWidth tests as explicit legacy-mode (no width arg); add width-mode tests: short line pads to W; L=W pads to W (1 row); L=W+1 pads to 2W (2 rows); blank line → zero padding (empty string row, no bg); padding never inside SGR run (width mode); odd W (e.g. 5) ceil math; W=0/undefined → legacy.

4. **[coder] FileReadBlock plumbing** — drone-agent/src/tui/components/FileReadBlock.tsx: pass `state.columns` through to `renderHighlightedTree(tree, codeBg, syntaxColors, state.columns)`.

5. **[coder] Populate state.columns in app.tsx** — drone-agent/src/tui/app.tsx, the three `customRender({...})` invocation sites (toolProgress ~line 250, toolCallBatch ~line 268, toolResultBatch ~line 322): add `columns: columnsRef.current`. Use a ref mirroring the existing `syntaxColorsRef` pattern (event handlers live in effect closures → stale-debounce risk). Source value from the existing `useDebouncedWindowSize(120)` (line ~108).

6. **[coder] Markdown width** — drone-agent/src/tui/components/Markdown.tsx: add `const { stdout } = useStdout()` (safe: Markdown is only element-instantiated); renderCodeBlock computes `W = (columnsProp ?? stdout.columns) − 4` and passes it to renderHighlightedTree. Keep an optional `columns` prop as an explicit override / test seam. Markdown has ~8 element instantiation sites; internal useStdout avoids touching them.

7. **[tester] Markdown code-block width test** — assert a code line longer than (columns−4) renders as exactly `ceil(L/(columns−4))` rows, each fully background-filled, no bare spill row; and that inner width (not terminal width) is used.

8. **[tester] FileReadBlock width tests** — drone-agent/test/pretty-tool-output.test.tsx: ToolRenderState with `columns` set: long line → ceil(L/W) rows; blank lines → empty rows (no background bar).

9. **[reviewer] Deferred follow-ups (do NOT fold into this feature)**: replace bare `===` truncation marker with explicit "… +N more line(s)"; line-number gutter; blank-line padding variant (pad to W instead of 0) if gaps in the band bother; prose-vs-code background treatment for .md files.

## Execution order / dependencies
1 → 2 → 3 (empirical check may amend step 2's constant) → {4+5} and {6} in parallel → 7, 8 → 9 deferred.
Cross-cutting caution: changing shared interfaces historically breaks stale test mocks — LSP find-references `ToolRenderState` constructions after step 1 (tests may construct the type; the new field is optional so mocks stay valid, but verify).

## Validation criteria
- LSP diagnostics: zero errors project-wide (all packages).
- `pnpm -r run build` passes with zero errors.
- `pnpm lint` passes (prettier will reformat — re-read files after any lint run before further edits).
- `pnpm test` (fast suite) green, including rewritten syntax-highlight.test.ts and pretty-tool-output.test.tsx.
- Manual smoke: launch TUI, `file__read` a wiki page with long prose lines (e.g. Obsidian drone-agent-project entities/Session.md 95–105): no full-width bare bands; blank lines render as empty rows; long lines wrap into fully-filled rows; short lines fill one row. Also render a markdown chat response containing a fenced code block with a long line.

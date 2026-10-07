---
tags: [decision, ui]
related: [drone-agent-tui.md, 036-ink-6-react-19.md]
---

# 037: Remove Ink 6 Incremental Rendering (Bordered Box Bug)

**Status**: Implemented (2026-07-01)

## Context

The Ink 5→6 upgrade ([036-ink-6-react-19](036-ink-6-react-19.md)) enabled `incrementalRendering: true` in `createTui()` — an Ink 6 feature that only redraws changed lines instead of the entire output, intended to reduce flicker on resize. However, this mode has a bug with bordered `<Box>` components.

When text inside a bordered `<Box>` (the input line) changed during typing, the incremental line-by-line diffing in Ink's `createIncremental()` (`log-update.js`) mispositioned the content line one row below the box instead of inside it. On submit, the box's top border (with corners) got "attached" to the submitted text in the chat log, confirming the line-positioning math was off by exactly one row.

The bug reproduced on Alacritty and Konsole; the fix was validated by removing the option.

## Decision

Remove `incrementalRendering: true` from the `render()` options in `createTui()`, reverting to Ink's standard full-redraw mode (same mode Ink 5 used, which worked correctly).

The `useDebouncedWindowSize` hook (added in the same Ink 5→6 upgrade) already handles resize flicker by debouncing rapid resize events during window drag, making `incrementalRendering` redundant.

## Rationale

- `incrementalRendering` in Ink 6.8.0 is unstable with bordered box layouts — the line-by-line diffing can't correctly track content changes inside bordered containers
- The `useDebouncedWindowSize` hook (120ms debounce) already mitigates resize flicker by coalescing rapid SIGWINCH events
- Standard full-redraw mode introduces no visual artifacts
- The `incrementalRendering` option also had a TypeScript type error (TS2353: not in `RenderOptions` union)

## Consequences

- No visual artifacts from line-by-line diffing during typing
- Full-redraw on resize is mitigated by the debounced resize hook
- The `error TS2353` on `incrementalRendering` is resolved
- The `resized()` handler in Ink's core still fires on every resize event during a drag, causing brief visual "stamping" of old layout characters when shrinking the terminal — accepted as an Ink 6 limitation (eraseLines can't reach above the new viewport)

## Files Changed

- `drone-agent/src/tui/index.tsx` — removed `incrementalRendering: true`, removed JSDoc mentioning it

## Related

- [drone-agent-tui](../../drone-agent/src/tui/) — TUI architecture
- [036-ink-6-react-19](036-ink-6-react-19.md) — The original Ink 5→6 upgrade that introduced this option
- [001-use-ink](001-use-ink.md) — Original Ink decision
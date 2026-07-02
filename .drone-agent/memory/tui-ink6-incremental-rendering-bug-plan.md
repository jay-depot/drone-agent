---
key: tui-ink6-incremental-rendering-bug-plan
tags:
  - tui
  - ink
  - incremental-rendering
  - bug
created: 2026-07-02T00:25:34.331Z
updated: 2026-07-02T00:25:34.331Z
---

# Plan: Fix Ink 6 Incremental Rendering Bug (Text Appears Below Input Box)

## Summary

The Ink 5→6 upgrade commit (7488909) enabled `incrementalRendering: true` in `createTui()`. Ink 6.8.0's incremental rendering mode (`createIncremental` in `log-update.js`) has a bug where line-by-line diffing misaligns the visual position of lines when the content inside a bordered `<Box>` changes. This causes the input line's content (LLM indicator, prompt label, typed text) to appear on the wrong line — below the box instead of inside it. When submitting, the top border of the input box gets "attached" to the submitted text in the chat log, confirming that the line-positioning math is off by exactly one line.

## Root Cause

In Ink 6's incremental rendering mode, the `createIncremental` function:

1. Splits the previous and current output into individual lines
2. Compares them line-by-line
3. Only rewrites lines that changed, using ANSI cursor positioning (`cursorUp`, `cursorTo(0)`, `eraseEndLine`)

The bug occurs because a bordered `<Box>` has multiple DOM child nodes (left border, content text, right border) that all render onto the same visual line. When the text content changes, only the text node re-renders — the border nodes remain the same. The incremental diff correctly detects the visual line changed, but the ANSI cursor positioning math (`cursorUp(previousVisible - 1)` then per-line `cursorTo(0) + content + eraseEndLine + '\n'`) doesn't properly account for the full visual height with borders, causing the content line to be written one row below its correct position.

The trailing `\n` behavior (when not in fullscreen mode) compounds this: the `outputToRender = output + '\n'` adds a blank line, and the `visibleLineCount` logic subtracts 1 for the trailing newline, creating a count mismatch.

## Fix

**Remove `incrementalRendering: true`** from `createTui()` in `src/tui/index.tsx`, reverting to Ink's standard full-redraw mode. This is the mode that Ink 5 used and that worked correctly. The `incrementalRendering` feature in Ink 6.8.0 is an opt-in optimization that is not yet stable with bordered box layouts.

## Plan Steps
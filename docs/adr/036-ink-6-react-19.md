---
tags: [decision, ui]
related:
  [drone-agent-tui.md, 001-use-ink.md, 037-incremental-rendering-removal.md]
---

# 036: Ink 5→6 Upgrade + React 18→19 + Debounced Resize Hook

**Status**: Implemented (2026-07-01), with post-release fix (2026-07-01)

## Context

The drone-agent TUI (Ink 5.2.0 + React 18) created visual artifacts (flickering, "stamping," duplicate content) when the terminal was resized. On every `SIGWINCH`, Ink erased all previous lines and rewrote the entire UI from scratch. When the window was dragged, dozens of resize events fired per second, each triggering a full erase-and-redraw cycle. The `previousLineCount` tracking got out of sync, creating visible ghost lines.

Additionally, React 18 and Ink 5 were already two major versions behind current releases.

## Decision

Apply two complementary changes:

### 1. Upgrade Ink 5→6 and React 18→19

- `ink`: `^5.2.0` → `^6.8.0`
- `react`: `^18.3.1` → `^19.2.7`
- `@types/react`: `^18.3.12` → `^19.2.17`

Ink 6.x brings:

- **PR #828 fix** for UI stamping on terminal shrink
- **Shared resize listener** (fewer duplicate re-renders)
- **`incrementalRendering` option** — only redraws changed lines instead of entire output (enabled in `createTui()`)

### 2. Debounced Window-Size Hook

Since Ink 6.8.0 does NOT export `useWindowSize`, a custom `useDebouncedWindowSize` hook was created using `useStdout` + `stdout.on('resize')` with a 120ms debounce timer. This coalesces rapid resize events during a drag gesture so that only the final size triggers a re-render.

## Rationale

- **Ink 6's `incrementalRendering`** directly addresses the ghost-line problem by only redrawing changed lines
- **Debouncing** prevents dozens of re-renders per second during window drag, giving Yoga layout time to compute stable positions before flushing output
- **React 19** is a requirement for Ink 6, and brings improved concurrent rendering and Suspense support

## Consequences

- **Breaking change: `JSX.Element` → `React.JSX.Element`** — React 19 types removed the global `JSX` namespace. All TUI component return type annotations had to be changed to `React.JSX.Element`, with `import type React from 'react'` added where React wasn't already imported as a value. This affected ~14 files across the TUI layer.
- **No other API breaks**: `useApp`, `useInput`, `useStdout`, `Box`, `Text`, `Spacer`, `Static`, `exitOnCtrlC` all unchanged in Ink 6
- **`<Static style={...}>`** still works with the new `Styles` type
- **`ink-text-input`** and **`ink-testing-library`** required no changes
- Pre-existing `llm-provider-switching.test.ts` type errors remain (unrelated to this change)

## Post-Release Fix: `incrementalRendering` Removed

Shortly after the upgrade was shipped, `incrementalRendering: true` was removed (see [037-incremental-rendering-removal](037-incremental-rendering-removal.md)). Ink 6.8.0's incremental mode has a bug with bordered `<Box>` components — the line-by-line diffing mispositions content when text inside a bordered box changes, causing input text to appear below the box. The `useDebouncedWindowSize` hook already mitigates resize flicker, making `incrementalRendering` redundant.

## Files Changed

- `drone-agent/package.json` — version bumps
- `drone-agent/src/tui/index.tsx` — enabled `incrementalRendering: true` (later removed in [037-incremental-rendering-removal](037-incremental-rendering-removal.md))
- `drone-agent/src/tui/hooks/useDebouncedWindowSize.ts` — **new file**, debounced resize hook
- `drone-agent/src/tui/app.tsx` — wired debounced hook
- 11 TUI component/test files — `JSX.Element` → `React.JSX.Element` migration
- `pnpm-lock.yaml` — lockfile update

## Related

- [037-incremental-rendering-removal](037-incremental-rendering-removal.md) — Post-release fix: removed `incrementalRendering`
- [drone-agent-tui](../../drone-agent/src/tui/) — TUI architecture
- [001-use-ink](001-use-ink.md) — Original Ink decision

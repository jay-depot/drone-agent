---
tags: [decision, ui]
related: [drone-agent-tui.md, 036-ink-6-react-19.md, 037-incremental-rendering-removal.md]
---

# ADR 001: Use Ink (React for CLIs) over Blessed

**Status**: Accepted (2026-06-19), upgraded to Ink 6 + React 19 (2026-07-01)

## Context

The TUI needed a framework for building a terminal UI. The initial prototype used Blessed (a popular Node.js TUI library), but it was replaced early in development.

## Decision

Use Ink (React for CLIs) instead of Blessed. Initially Ink 5.x + React 18; later upgraded to Ink 6.x + React 19 (see [[036-ink-6-react-19]]).

## Rationale

- **React model**: Ink's component-based, declarative model is more maintainable and composable than Blessed's imperative API
- **Hooks**: React hooks enable clean state management and side effect handling
- **Testing**: `ink-testing-library` provides good testing support for TUI components
- **Community**: Ink is actively maintained and widely used
- **No alternate screen buffer**: Ink can render inline with terminal history, preserving output after exit

## Consequences

- TUI components are React components with hooks
- Layout is managed declaratively (Box, Text, Static, etc.)
- Testing uses `ink-testing-library`
- The TUI deliberately avoids the alternate screen buffer
- Ink 6 uses standard full-redraw mode — `incrementalRendering` was briefly tried but removed due to a bordered box rendering bug (see [[037-incremental-rendering-removal]])
- React 19 removed global `JSX` namespace — all ReturnType annotations use `React.JSX.Element`

## Related

- [[drone-agent-tui]] — TUI architecture
- [[036-ink-6-react-19]] — Details of the Ink 5→6 + React 18→19 upgrade
- [[037-incremental-rendering-removal]] — Why `incrementalRendering` was removed
---
tags: [decision, tui, input, paste]
related:
  [
    modules/drone-agent-tui.md,
    decisions/077-tui-syntax-highlighting-ansi-escape-codes.md,
  ]
---

# Decision 099: TUI Paste Handling — Bracketed Paste Detection + Debounce Fallback

**Summary**: Add paste handling to the TUI's `MultilineTextInput` and `FreeformInput` components using a shared `useBracketedPaste` hook with dual detection mechanisms.

## Context

The TUI had no explicit paste handling. Pasted text arrived as a rapid sequence of individual `useInput` callbacks, each triggering a React state update. For large pastes (10K+ characters), this caused 10K+ sequential re-renders, leading to visual mangling (spurious newlines, cursor jumps, lost text).

Additionally, pasted newlines (`\r`) were treated as Enter/submit in some scenarios, causing premature submission of partial text. Even after the initial fix, pasted `\r\n` or bare `\r` characters survived into the value string: Ink's output engine splits on `\n` only, so `\r` causes a terminal carriage return (cursor jumps to column 0 on the same line) instead of advancing to the next line. This was the root cause of pasted newlines not rendering correctly unless text happened to soft-wrap right before the newline.

## Decision

Create a shared `useBracketedPaste` hook with two mechanisms:

1. **Bracketed paste detection** (primary): Listen to `process.stdin` raw `data` events and detect `\x1b[200~` (paste start) and `\x1b[201~` (paste end) sequences. Everything between them is buffered and delivered as a single atomic string via `onPaste`.

2. **Debounce fallback** (secondary): Monitor inter-character timing from `useInput`. If characters arrive faster than human typing speed (< 30ms between chars), they are buffered and flushed after a 50ms pause. This catches pastes in terminals without bracketed paste support.

Both `MultilineTextInput` and `FreeformInput` use this hook independently. Since they're never both accepting input simultaneously (elicitation disables the main input), there's no conflict.

### Test interaction with debounce fallback

The debounce fallback intercepts characters that arrive < 30ms apart. Tests that type commands character by character with 20ms delays fall under this threshold — only the first character is delivered immediately; the rest are buffered and don't flush until after `\r` triggers submit, causing the command to be incomplete (e.g., just `/` instead of `/systemprompt`).

Fix: write the full command string at once via `stdin.write('/command')` so Ink's input parser delivers it as a single multi-character `useInput` event, bypassing the debounce path entirely.

### Line ending normalization

Clipboard content and bracketed paste data can contain `\r\n` (Windows clipboard, some GUI apps) or bare `\r` (old Mac, terminal raw mode). Ink's output engine (`output.js`) splits text on `\n` only — a `\r` survives as a literal character and causes the terminal to perform a carriage return, pulling the cursor back to column 0 instead of advancing to the next line.

The `normalizePastedText()` helper converts `\r\n` → `\n` first, then any remaining bare `\r` → `\n`. The order matters: replacing `\r\n` before `\r` avoids double-converting `\r\n` into `\n\n`.

Normalization is applied at all four paste delivery points:

1. Bracketed paste, split across chunks
2. Bracketed paste, complete in one chunk
3. Debounce fallback flush
4. Debounce fallback immediate delivery

### Line ending normalization

Clipboard content and bracketed paste data can contain `\r\n` (Windows clipboard, some GUI apps) or bare `\r` (old Mac, terminal raw mode). Ink's output engine (`output.js`) splits text on `\n` only — a `\r` survives as a literal character and causes the terminal to perform a carriage return, pulling the cursor back to column 0 instead of advancing to the next line.

The `normalizePastedText()` helper converts `\r\n` → `\n` first, then any remaining bare `\r` → `\n`. The order matters: replacing `\r\n` before `\r` avoids double-converting `\r\n` into `\n\n`.

Normalization is applied at all four paste delivery points:

1. Bracketed paste, split across chunks
2. Bracketed paste, complete in one chunk
3. Debounce fallback flush
4. Debounce fallback immediate delivery

## Key Design Decisions

### Why not just debounce?

A pure debounce approach has a race condition: if the user types slowly (e.g., thinking mid-sentence), the debounce could flush mid-paste, causing the same visual mangling. Bracketed paste detection is the correct solution — it captures the entire paste atomically.

### Why tap into `process.stdin` directly?

Ink's `useInput` doesn't expose raw data or bracketed paste sequences. The hook listens to `process.stdin` `data` events at a lower level to detect the escape sequences.

### Why keep both components separate?

`FreeformInput` is intentionally minimal (no cursor navigation, no multiline) and replacing it with `MultilineTextInput` would add complexity to a component meant for quick inline answers. A future multiline elicitation prompt should be a separate decision.

### Debounce fallback behavior

The first character is always delivered immediately because `lastCharTimeRef` starts at 0 (`Date.now() - 0 > 30ms`). This means rapid pastes without bracketed paste support will have the first character appear instantly, then the rest appears atomically after a brief 50ms pause. This is acceptable — the user sees immediate feedback, then the full paste appears.

## Implementation

**New file:** `drone-agent/src/tui/hooks/useBracketedPaste.ts`

- Listens to `process.stdin` `data` events
- Detects `\x1b[200~` / `\x1b[201~` sequences
- Buffers content between markers, delivers atomically
- Normalizes `\r\n` → `\n` and `\r` → `\n` via `normalizePastedText()` at all delivery points
- Handles multi-chunk paste data (start marker in one chunk, end in another)
- Tracks `lastCharTimeRef` for debounce fallback
- Exposes `onCharInput` method for `useInput` handlers
- Cleans up stdin listener on unmount

**Modified files:**

- `drone-agent/src/tui/components/MultilineTextInput.tsx` — Routes printable characters through `onCharInput`; paste callback inserts at cursor offset
- `drone-agent/src/tui/components/ElicitationPrompt.tsx` (`FreeformInput`) — Same pattern; paste callback appends to value

## Files Changed

| File                                                    | Change                                            |
| ------------------------------------------------------- | ------------------------------------------------- |
| `drone-agent/src/tui/hooks/useBracketedPaste.ts`        | **New** — shared paste detection hook             |
| `drone-agent/src/tui/components/MultilineTextInput.tsx` | Integrate hook, route chars through `onCharInput` |
| `drone-agent/src/tui/components/ElicitationPrompt.tsx`  | Integrate hook into `FreeformInput`               |
| `drone-agent/test/useBracketedPaste.test.tsx`           | **New** — 9 tests for the hook                    |
| `drone-agent/test/multiline-text-input.test.tsx`        | 4 new paste-related tests                         |
| `drone-agent/test/useBracketedPaste.test.tsx`           | 4 new `\r`/`\r\n` normalization tests (13 total)  |

## Test Coverage

- **Bracketed paste detection**: Single chunk, multi-chunk, multiple sequences, non-paste data ignored, stdin listener registration
- **Debounce fallback**: Single char immediate delivery, rapid char buffering + flush, flush-on-slow-char, paste-active suppression
- **MultilineTextInput paste**: Renders pasted text at end, with newlines, large pastes without truncation, cursor at start

## Status

Implemented on branch `fix/tui-paste-handling` (commits `c5d3d36`, `5b363a4`, `1e4f04c`). PR [#33](https://github.com/jay-depot/drone-agent/pull/33) open.

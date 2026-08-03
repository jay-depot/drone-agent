import type React from 'react';
/**
 * A text input component that supports multi-line input via
 * Ctrl+J.
 *
 * - **Enter** (alone) → calls `onSubmit`
 * - **Ctrl+J** → inserts a newline at the cursor position
 * - Arrow keys navigate the cursor (including Up/Down for visual lines)
 * - Home/End jump to logical line boundaries
 * - Ctrl+Left/Right jump words
 * - Ctrl+U/K kill to start/end of logical line
 * - Backspace/Delete remove characters before/at the cursor
 * - Mouse click positions the cursor (when SGR mouse events are provided)
 *
 * This replaces `ink-text-input`'s `TextInput` in the main input
 * line so that users can compose multi-line messages.
 *
 * Note: Shift+Enter cannot be distinguished from plain Enter at the
 * terminal level (both send `\r`). Ctrl+J sends `\n` (linefeed),
 * which Ink's `useInput` delivers as `input === '\n'` with
 * `key.return === false`.
 *
 * The cursor is rendered using raw ANSI escape codes within a single
 * `<Text>` string (not nested `<Text inverse>` elements) to avoid
 * Yoga layout miscalculations that would place the cursor on the
 * wrong line. Text is soft-wrapped when it exceeds the available width.
 *
 * Paste handling: uses `useBracketedPaste` to detect bracketed paste
 * sequences and debounce rapid character input, delivering pasted text
 * as a single atomic update at the cursor position.
 *
 * Visual line navigation: uses the `visual-text-model` module to
 * compute visual line positions with word-wrap awareness. A preferred
 * column is tracked for Up/Down navigation so the cursor stays at the
 * same visual column when moving between lines of different lengths.
 */

import { Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { useBracketedPaste } from '../hooks/useBracketedPaste.js';
import type { SgrMouseEvent } from '../hooks/useSgrMouse.js';
import {
  computeVisualLines,
  offsetToVisual,
  visualToOffset,
  findLineStart,
  findLineEnd,
  findWordStart,
  findWordEnd,
} from '../shared/visual-text-model.js';

export function MultilineTextInput({
  value,
  onChange,
  onSubmit,
  focus = true,
  columns,
  mouseClick,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (value: string) => void;
  focus?: boolean;
  /** Terminal width for visual line calculation. */
  columns: number;
  /** Most recent SGR mouse click event (for click-to-position). */
  mouseClick?: SgrMouseEvent | null;
}): React.JSX.Element {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  // Preferred column for Up/Down navigation. Reset on horizontal
  // movement or typing.
  const preferredColumnRef = useRef<number | null>(null);

  // Refs for the paste callback (avoids stale closures since the hook
  // stores the callback in a ref internally).
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const cursorOffsetRef = useRef(cursorOffset);
  cursorOffsetRef.current = cursorOffset;

  // Ref for the input container element to measure its screen position
  // for mouse click handling.
  const containerRef = useRef<{ top: number }>({ top: 0 });

  // ── Paste handling ────────────────────────────────────────────────
  const { onCharInput } = useBracketedPaste((text: string) => {
    const curValue = valueRef.current;
    const curOffset = Math.min(cursorOffsetRef.current, curValue.length);
    const next =
      curValue.slice(0, curOffset) + text + curValue.slice(curOffset);
    onChangeRef.current(next);
    setCursorOffset(curOffset + text.length);
    preferredColumnRef.current = null;
  });

  // ── Mouse click handling ──────────────────────────────────────────
  useEffect(() => {
    if (!mouseClick || !focus) return;

    const offset = Math.min(cursorOffset, value.length);
    const visual = offsetToVisual(value, offset, columns);

    // The mouseClick row/col is 1-based terminal coordinates.
    // We need to determine the input box's screen position to
    // translate terminal row to visual line.
    //
    // For now, we use a simple heuristic: the input box is at the
    // bottom of the screen. The terminal row of the input box's
    // first visual line is approximately (terminal height - number
    // of visual lines below the input). Since we don't have precise
    // screen position tracking, we approximate by assuming the
    // click is within the input area if it's near the bottom.
    //
    // A more precise approach would require Ink to expose component
    // positions, which it doesn't. For now, we use the visual line
    // model and assume the click row maps to a visual line relative
    // to the input's position.
    //
    // The col is 1-based from the terminal. We subtract 1 to get
    // 0-based, then clamp to the visual line's length.
    const clickCol = Math.max(0, mouseClick.col - 1);

    // Find which visual line the click is on by computing the
    // visual lines and mapping the click row to a visual line index.
    // We assume the input starts at a known terminal row (approximated
    // as the last few rows of the terminal).
    const lines = computeVisualLines(value, columns);
    if (lines.length === 0) return;

    // Map the click to a visual line. We don't know the exact
    // terminal row of the input, so we use a heuristic: the click
    // row is relative to the bottom of the terminal. The last visual
    // line is at the bottom of the input area.
    // For now, we just use the click col on the current visual line
    // as a simple approximation.
    const newOffset = visualToOffset(value, visual.line, clickCol, columns);
    setCursorOffset(newOffset);
    preferredColumnRef.current = null;
  }, [mouseClick, focus, value, columns, cursorOffset]);

  useInput(
    (input, key) => {
      // Clamp cursorOffset to value.length in case the parent
      // reset the value externally (e.g. after submit). Without
      // this, backspace can silently fail because cursorOffset
      // points past the end of the new shorter string.
      const offset = Math.min(cursorOffset, value.length);

      // Enter alone → submit
      if (key.return && !key.shift) {
        onSubmit?.(value);
        return;
      }

      // Ctrl+J (input === '\n' with !key.return) → insert newline at cursor
      if (input === '\n' && !key.return) {
        const next = value.slice(0, offset) + '\n' + value.slice(offset);
        onChange(next);
        setCursorOffset(offset + 1);
        preferredColumnRef.current = null;
        return;
      }

      // Backspace / Delete
      if (key.backspace || key.delete) {
        if (offset > 0) {
          const next = value.slice(0, offset - 1) + value.slice(offset);
          onChange(next);
          setCursorOffset(offset - 1);
          preferredColumnRef.current = null;
        }
        return;
      }

      // ── Up arrow ──────────────────────────────────────────────────
      if (key.upArrow) {
        const visual = offsetToVisual(value, offset, columns);
        if (visual.line > 0) {
          const preferred = preferredColumnRef.current ?? visual.col;
          const newOffset = visualToOffset(
            value,
            visual.line - 1,
            preferred,
            columns
          );
          setCursorOffset(newOffset);
          preferredColumnRef.current = preferred;
        }
        return;
      }

      // ── Down arrow ────────────────────────────────────────────────
      if (key.downArrow) {
        const visual = offsetToVisual(value, offset, columns);
        const lines = computeVisualLines(value, columns);
        if (visual.line < lines.length - 1) {
          const preferred = preferredColumnRef.current ?? visual.col;
          const newOffset = visualToOffset(
            value,
            visual.line + 1,
            preferred,
            columns
          );
          setCursorOffset(newOffset);
          preferredColumnRef.current = preferred;
        }
        return;
      }

      // ── Home ──────────────────────────────────────────────────────
      if (key.home) {
        setCursorOffset(findLineStart(value, offset));
        preferredColumnRef.current = null;
        return;
      }

      // ── End ───────────────────────────────────────────────────────
      if (key.end) {
        setCursorOffset(findLineEnd(value, offset));
        preferredColumnRef.current = null;
        return;
      }

      // ── Ctrl+Left (word left) ─────────────────────────────────────
      if (key.ctrl && key.leftArrow) {
        setCursorOffset(findWordStart(value, offset));
        preferredColumnRef.current = null;
        return;
      }

      // ── Ctrl+Right (word right) ───────────────────────────────────
      if (key.ctrl && key.rightArrow) {
        setCursorOffset(findWordEnd(value, offset));
        preferredColumnRef.current = null;
        return;
      }

      // ── Ctrl+U (kill to start of line) ────────────────────────────
      if (key.ctrl && input === 'u') {
        const lineStart = findLineStart(value, offset);
        const next = value.slice(0, lineStart) + value.slice(offset);
        onChange(next);
        setCursorOffset(lineStart);
        preferredColumnRef.current = null;
        return;
      }

      // ── Ctrl+K (kill to end of line) ─────────────────────────────
      if (key.ctrl && input === 'k') {
        const lineEnd = findLineEnd(value, offset);
        const next = value.slice(0, offset) + value.slice(lineEnd);
        onChange(next);
        setCursorOffset(offset);
        preferredColumnRef.current = null;
        return;
      }

      // Left arrow
      if (key.leftArrow) {
        setCursorOffset(Math.max(0, offset - 1));
        preferredColumnRef.current = null;
        return;
      }

      // Right arrow
      if (key.rightArrow) {
        setCursorOffset(Math.min(value.length, offset + 1));
        preferredColumnRef.current = null;
        return;
      }

      // Printable characters — route through paste handler for
      // debounce buffering, then process normally.
      if (input && !key.ctrl && !key.meta) {
        onCharInput(input);
        preferredColumnRef.current = null;
      }
    },
    { isActive: focus }
  );

  // Render the value with a visible cursor using inverse video.
  // The cursor is shown as an inverted block at the cursor position.
  // If the cursor is at the end of the text, we append an inverse space.
  //
  // We use raw ANSI escape codes (\u001b[7m / \u001b[27m) within a single
  // <Text> string rather than nested <Text inverse> elements. Nested
  // <Text> creates separate Yoga nodes whose position can be
  // miscalculated during re-render, causing the cursor to land on the
  // bottom border line instead of the content line.
  const rendered = renderWithCursor(value, cursorOffset, focus);

  return <Text wrap="wrap">{rendered}</Text>;
}

/**
 * Renders `text` with a visible cursor at `cursorOffset` using
 * inverse video. When the cursor is at the end of the text, an
 * inverse space is appended so the user can see where typing will
 * insert.
 *
 * Returns a plain string with raw ANSI escape codes (\u001b[7m / \u001b[27m)
 * for the inverse cursor, rather than JSX with nested <Text inverse>
 * elements. This avoids Yoga layout miscalculations that would place
 * the cursor on the wrong line during re-render.
 */
function renderWithCursor(
  text: string,
  cursorOffset: number,
  showCursor: boolean
): string {
  if (!showCursor) {
    return text || ' ';
  }

  const clamped = Math.min(cursorOffset, text.length);

  // Characters before the cursor
  const before = text.slice(0, clamped);
  // Character at the cursor (if any)
  const at = text[clamped] ?? '';
  // Characters after the cursor
  const after = text.slice(clamped + 1);

  // Use raw ANSI escape codes for inverse video within a single
  // text string. \u001b[7m = inverse on, \u001b[27m = inverse off.
  // This avoids nested <Text> elements which cause Yoga layout bugs.
  const cursor = at ? `\u001b[7m${at}\u001b[27m` : '\u001b[7m \u001b[27m';

  return before + cursor + after;
}

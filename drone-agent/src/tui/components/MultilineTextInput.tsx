import type React from 'react';
/**
 * A text input component that supports multi-line input via
 * Ctrl+J.
 *
 * - **Enter** (alone) → calls `onSubmit`
 * - **Ctrl+J** → inserts a newline at the cursor position
 * - Arrow keys navigate the cursor
 * - Backspace/Delete remove characters before/at the cursor
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
 * wrong line. Text is truncated with an ellipsis when it exceeds
 * the available width, keeping the input box at a single-line height.
 *
 * Paste handling: uses `useBracketedPaste` to detect bracketed paste
 * sequences and debounce rapid character input, delivering pasted text
 * as a single atomic update at the cursor position.
 */

import { Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { useBracketedPaste } from '../hooks/useBracketedPaste.js';

export function MultilineTextInput({
  value,
  onChange,
  onSubmit,
  focus = true,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (value: string) => void;
  focus?: boolean;
}): React.JSX.Element {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  // Refs for the paste callback (avoids stale closures since the hook
  // stores the callback in a ref internally).
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const cursorOffsetRef = useRef(cursorOffset);
  cursorOffsetRef.current = cursorOffset;

  // ── Paste handling ────────────────────────────────────────────────
  const { onCharInput } = useBracketedPaste((text: string) => {
    const curValue = valueRef.current;
    const curOffset = Math.min(cursorOffsetRef.current, curValue.length);
    const next =
      curValue.slice(0, curOffset) + text + curValue.slice(curOffset);
    onChangeRef.current(next);
    setCursorOffset(curOffset + text.length);
  });

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
        return;
      }

      // Backspace / Delete
      if (key.backspace || key.delete) {
        if (offset > 0) {
          const next = value.slice(0, offset - 1) + value.slice(offset);
          onChange(next);
          setCursorOffset(offset - 1);
        }
        return;
      }

      // Left arrow
      if (key.leftArrow) {
        setCursorOffset(Math.max(0, offset - 1));
        return;
      }

      // Right arrow
      if (key.rightArrow) {
        setCursorOffset(Math.min(value.length, offset + 1));
        return;
      }

      // Printable characters — route through paste handler for
      // debounce buffering, then process normally.
      if (input && !key.ctrl && !key.meta) {
        onCharInput(input);
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

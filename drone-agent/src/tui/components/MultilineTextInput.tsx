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
 */

import { Text, useInput } from 'ink';
import { useState } from 'react';

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
}): JSX.Element {
  const [cursorOffset, setCursorOffset] = useState(value.length);

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
        const next =
          value.slice(0, offset) + '\n' + value.slice(offset);
        onChange(next);
        setCursorOffset(offset + 1);
        return;
      }

      // Backspace / Delete
      if (key.backspace || key.delete) {
        if (offset > 0) {
          const next =
            value.slice(0, offset - 1) + value.slice(offset);
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

      // Printable characters (ignore ctrl/meta sequences)
      if (input && !key.ctrl && !key.meta) {
        const next =
          value.slice(0, offset) + input + value.slice(offset);
        onChange(next);
        setCursorOffset(offset + input.length);
      }
    },
    { isActive: focus }
  );

  // Render the value with a visible cursor using inverse video.
  // The cursor is shown as an inverted block at the cursor position.
  // If the cursor is at the end of the text, we append an inverse space.
  const rendered = renderWithCursor(value, cursorOffset, focus);

  return <Text>{rendered}</Text>;
}

/**
 * Renders `text` with a visible cursor at `cursorOffset` using
 * inverse video. When the cursor is at the end of the text, an
 * inverse space is appended so the user can see where typing will
 * insert.
 */
function renderWithCursor(
  text: string,
  cursorOffset: number,
  showCursor: boolean
): JSX.Element {
  if (!showCursor) {
    return <>{text || ' '}</>;
  }

  const clamped = Math.min(cursorOffset, text.length);

  // Characters before the cursor
  const before = text.slice(0, clamped);
  // Character at the cursor (if any)
  const at = text[clamped] ?? '';
  // Characters after the cursor
  const after = text.slice(clamped + 1);

  return (
    <>
      {before}
      {at ? (
        <Text inverse>{at}</Text>
      ) : (
        // Cursor at end: show an inverse space so the user sees
        // where typing will insert.
        <Text inverse> </Text>
      )}
      {after}
    </>
  );
}

/**
 * A text input component that supports multi-line input via
 * Shift+Enter.
 *
 * - **Enter** (alone) → calls `onSubmit`
 * - **Shift+Enter** → inserts a newline at the cursor position
 * - Arrow keys navigate the cursor
 * - Backspace/Delete remove characters before/at the cursor
 *
 * This replaces `ink-text-input`'s `TextInput` in the main input
 * line so that users can compose multi-line messages.
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
      // Enter alone → submit
      if (key.return && !key.shift) {
        onSubmit?.(value);
        return;
      }

      // Shift+Enter → insert newline at cursor
      if (key.return && key.shift) {
        const next =
          value.slice(0, cursorOffset) + '\n' + value.slice(cursorOffset);
        onChange(next);
        setCursorOffset(cursorOffset + 1);
        return;
      }

      // Backspace / Delete
      if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          const next =
            value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
          onChange(next);
          setCursorOffset(cursorOffset - 1);
        }
        return;
      }

      // Left arrow
      if (key.leftArrow) {
        setCursorOffset(Math.max(0, cursorOffset - 1));
        return;
      }

      // Right arrow
      if (key.rightArrow) {
        setCursorOffset(Math.min(value.length, cursorOffset + 1));
        return;
      }

      // Printable characters (ignore ctrl/meta sequences)
      if (input && !key.ctrl && !key.meta) {
        const next =
          value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
        onChange(next);
        setCursorOffset(cursorOffset + input.length);
      }
    },
    { isActive: focus }
  );

  // Render the value (or a space placeholder so the box keeps its height).
  return <Text>{value.length > 0 ? value : ' '}</Text>;
}

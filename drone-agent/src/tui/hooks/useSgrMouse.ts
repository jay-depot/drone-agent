/**
 * Hook for SGR mouse mode (1000 + 1006) in the TUI.
 *
 * Enables SGR mouse mode on mount and disables on unmount.
 * Only mode 1000 (button press/release events) is enabled,
 * NOT mode 1002 (drag events). This preserves native text
 * selection via drag in the terminal.
 *
 * ## SGR mouse mode
 *
 * - Mode 1000: Report button press and release events.
 * - Mode 1006: SGR extended coordinates (supports > 223 rows/cols).
 *
 * Mouse events arrive as escape sequences:
 *   Press:   \x1b[<row;col;buttonM
 *   Release: \x1b[<row;col;buttonm
 *
 * Button codes: 0=left, 1=middle, 2=right, 32+modifier=motion (not used)
 *
 * ## Text selection preservation
 *
 * By NOT enabling mode 1002, drag events are not captured by the
 * application. The terminal's native drag-to-select behavior works
 * normally. Only single clicks are reported.
 */

import { useEffect, useRef, useState } from 'react';

/** A parsed SGR mouse event. */
export type SgrMouseEvent = {
  /** 1-based terminal row. */
  row: number;
  /** 1-based terminal column. */
  col: number;
  /** Which button was pressed/released. */
  button: 'left' | 'middle' | 'right';
  /** Whether this is a press or release. */
  action: 'press' | 'release';
};

// SGR mouse escape sequences
const SGR_MOUSE_ENABLE = '\x1b[?1000h\x1b[?1006h';
const SGR_MOUSE_DISABLE = '\x1b[?1000l\x1b[?1006l';

// SGR mouse event regex: \x1b[<row;col;buttonM or \x1b[<row;col;buttonm
const ESC = String.fromCharCode(27);
const SGR_MOUSE_RE = new RegExp('^' + ESC + '\\[<(\\d+);(\\d+);(\\d+)([Mm])');

/**
 * Hook that enables SGR mouse mode and returns click events.
 *
 * @returns An object with `lastClick` — the most recent mouse click
 *   event, or `null` if no click has occurred yet.
 */
export function useSgrMouse(): { lastClick: SgrMouseEvent | null } {
  const [lastClick, setLastClick] = useState<SgrMouseEvent | null>(null);
  const bufferRef = useRef<string>('');

  useEffect(() => {
    // Only enable if stdin is a TTY
    if (!process.stdin.isTTY) return;

    // Enable SGR mouse mode
    process.stdout.write(SGR_MOUSE_ENABLE);

    const handler = (chunk: Buffer) => {
      bufferRef.current += chunk.toString('utf-8');

      // Process all complete sequences in the buffer
      while (bufferRef.current.length > 0) {
        const match = bufferRef.current.match(SGR_MOUSE_RE);
        if (!match) {
          // No complete sequence — keep buffering
          break;
        }

        const [, rowStr, colStr, buttonStr, actionChar] = match;
        const row = Number.parseInt(rowStr, 10);
        const col = Number.parseInt(colStr, 10);
        const buttonCode = Number.parseInt(buttonStr, 10);
        const isPress = actionChar === 'M';

        // Button codes: 0=left, 1=middle, 2=right
        // Codes 32+ are motion events (not captured since we don't
        // enable mode 1002, but handle gracefully)
        let button: 'left' | 'middle' | 'right';
        const baseCode = buttonCode & ~32; // strip motion modifier
        if (baseCode === 0) button = 'left';
        else if (baseCode === 1) button = 'middle';
        else button = 'right';

        setLastClick({
          row,
          col,
          button,
          action: isPress ? 'press' : 'release',
        });

        // Remove the processed sequence from the buffer
        bufferRef.current = bufferRef.current.slice(match[0].length);
      }
    };

    process.stdin.on('data', handler);

    return () => {
      process.stdin.off('data', handler);
      process.stdout.write(SGR_MOUSE_DISABLE);
    };
  }, []);

  return { lastClick };
}

/**
 * Hook that debounces Ink's window resize events.
 *
 * Terminal resize events (SIGWINCH) fire dozens of times per second
 * during a drag gesture. Each one triggers Ink to erase and redraw
 * the entire UI. This hook coalesces rapid resize events into a
 * single update after the user stops dragging (debounceMs), reducing
 * visual flicker and "stamping" artifacts.
 *
 * Uses Ink's `useStdout` hook and listens for the `resize` event on
 * the stdout stream. Falls back to columns=80, rows=24 if the stream
 * is not a TTY.
 */

import { useStdout } from 'ink';
import { useEffect, useRef, useState } from 'react';

export interface WindowSize {
  columns: number;
  rows: number;
}

/**
 * Get the current terminal size from a WriteStream.
 */
function getTerminalSize(stdout: NodeJS.WriteStream): WindowSize {
  return {
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  };
}

/**
 * Returns the debounced terminal window size.
 *
 * @param debounceMs - Debounce delay in milliseconds (default 120).
 *   During a window-drag gesture, only the final size that holds for
 *   this long triggers a re-render.
 */
export function useDebouncedWindowSize(debounceMs = 120): WindowSize {
  const { stdout } = useStdout();
  const [debounced, setDebounced] = useState<WindowSize>(
    () => getTerminalSize(stdout)
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleResize = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        setDebounced(getTerminalSize(stdout));
      }, debounceMs);
    };

    stdout.on('resize', handleResize);

    return () => {
      stdout.off('resize', handleResize);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [stdout, debounceMs]);

  return debounced;
}
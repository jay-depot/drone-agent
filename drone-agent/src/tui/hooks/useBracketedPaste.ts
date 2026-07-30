/**
 * Hook for detecting and buffering pasted text in the TUI.
 *
 * Uses two mechanisms:
 *
 * 1. **Bracketed paste detection** (primary): Listens to `process.stdin`
 *    raw `data` events and detects `\x1b[200~` (paste start) and
 *    `\x1b[201~` (paste end) sequences. Everything between them is
 *    buffered and delivered as a single atomic string via `onPaste`.
 *
 * 2. **Debounce fallback** (secondary): Monitors inter-character timing
 *    from `useInput`. If characters arrive faster than human typing speed
 *    (< 30ms between chars), they are buffered and flushed after a 50ms
 *    pause. This catches pastes in terminals without bracketed paste support.
 *
 * The component provides the `onPaste` callback. The hook returns
 * `onCharInput` which the component should call from its `useInput`
 * handler for printable characters instead of processing them directly.
 */

import { useEffect, useRef } from 'react';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const DEBOUNCE_THRESHOLD_MS = 30;
const FLUSH_DELAY_MS = 50;

export function useBracketedPaste(onPaste: (text: string) => void): {
  onCharInput: (input: string) => void;
} {
  // ── Bracketed paste state ──────────────────────────────────────────
  const pasteBufferRef = useRef<string>('');
  const inPasteRef = useRef<boolean>(false);
  const stdinDataRef = useRef<string>('');

  // ── Debounce fallback state ─────────────────────────────────────────
  const debounceBufferRef = useRef<string>('');
  // Initialize to 0 so the first character always appears "slow" and is
  // delivered immediately (elapsed = Date.now() - 0 > 30ms).
  const lastCharTimeRef = useRef<number>(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Store onPaste in a ref to avoid re-subscribing stdin on every render.
  const onPasteRef = useRef(onPaste);
  onPasteRef.current = onPaste;

  // ── Bracketed paste: stdin data listener ────────────────────────────
  useEffect(() => {
    const handler = (chunk: Buffer) => {
      const str = chunk.toString('utf-8');
      stdinDataRef.current += str;

      // Process all complete sequences in the accumulated data.
      let processed = false;

      while (stdinDataRef.current.length > 0) {
        // If we're already inside a paste, look for the end marker first.
        if (inPasteRef.current) {
          const endIdx = stdinDataRef.current.indexOf(BRACKETED_PASTE_END);
          if (endIdx === -1) {
            // End marker not yet received; buffer everything and wait.
            pasteBufferRef.current += stdinDataRef.current;
            stdinDataRef.current = '';
            processed = true;
            break;
          }

          // End marker found — extract content before it.
          const content = stdinDataRef.current.slice(0, endIdx);
          pasteBufferRef.current += content;
          stdinDataRef.current = stdinDataRef.current.slice(
            endIdx + BRACKETED_PASTE_END.length
          );

          // Deliver the complete paste.
          const text = pasteBufferRef.current;
          pasteBufferRef.current = '';
          inPasteRef.current = false;
          onPasteRef.current(text);
          processed = true;
          // Continue loop in case there's another paste sequence.
          continue;
        }

        // Not inside a paste — look for the start marker.
        const startIdx = stdinDataRef.current.indexOf(BRACKETED_PASTE_START);
        if (startIdx === -1) {
          // No start marker; nothing to process.
          break;
        }

        // Discard anything before the paste start marker.
        const afterStart = stdinDataRef.current.slice(
          startIdx + BRACKETED_PASTE_START.length
        );

        // Check if the end marker is in the same chunk.
        const endIdx = afterStart.indexOf(BRACKETED_PASTE_END);
        if (endIdx === -1) {
          // Paste end not yet received; buffer and wait.
          inPasteRef.current = true;
          pasteBufferRef.current = afterStart;
          stdinDataRef.current = '';
          processed = true;
          break;
        }

        // Complete paste in one chunk.
        inPasteRef.current = true;
        const pasteContent = afterStart.slice(0, endIdx);
        stdinDataRef.current = afterStart.slice(
          endIdx + BRACKETED_PASTE_END.length
        );

        // Deliver the paste.
        pasteBufferRef.current = '';
        inPasteRef.current = false;
        onPasteRef.current(pasteContent);
        processed = true;
        // Continue loop in case there's another paste sequence.
        continue;
      }

      if (!processed) {
        // No bracketed paste sequence detected; keep accumulating in case
        // the start marker arrives across multiple chunks.
        stdinDataRef.current = str;
      }
    };

    process.stdin.on('data', handler);
    return () => {
      process.stdin.off('data', handler);
    };
  }, []);

  // ── Debounce fallback: flush helper ────────────────────────────────
  const flushDebounceBuffer = () => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const text = debounceBufferRef.current;
    if (text.length > 0) {
      debounceBufferRef.current = '';
      onPasteRef.current(text);
    }
  };

  // ── onCharInput: called by the component's useInput handler ─────────
  const onCharInput = (input: string) => {
    // If we're inside a bracketed paste, the stdin listener handles it.
    if (inPasteRef.current) return;

    const now = Date.now();
    const elapsed = now - lastCharTimeRef.current;
    lastCharTimeRef.current = now;

    if (elapsed < DEBOUNCE_THRESHOLD_MS) {
      // Rapid input — buffer and schedule flush.
      debounceBufferRef.current += input;
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
      flushTimerRef.current = setTimeout(flushDebounceBuffer, FLUSH_DELAY_MS);
    } else {
      // Normal typing speed — flush any pending buffer first, then
      // deliver this character immediately.
      flushDebounceBuffer();
      onPasteRef.current(input);
    }
  };

  return { onCharInput };
}

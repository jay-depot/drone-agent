/**
 * Tests for useBracketedPaste — the paste detection and buffering hook.
 *
 * The hook has two mechanisms:
 * 1. Bracketed paste detection via process.stdin data events
 * 2. Debounce fallback via onCharInput timing
 *
 * We test both paths. For the stdin path, we mock process.stdin to
 * capture the data handler and simulate paste sequences.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { useBracketedPaste } from '../src/tui/hooks/useBracketedPaste.js';

type PasteApi = ReturnType<typeof useBracketedPaste>;

/**
 * Creates a test harness that renders a component using useBracketedPaste
 * and captures the onCharInput method and paste callback.
 */
function createHarness() {
  const captured: {
    onCharInput?: PasteApi['onCharInput'];
    pastedTexts: string[];
  } = { pastedTexts: [] };

  function Harness() {
    const { onCharInput } = useBracketedPaste((text: string) => {
      captured.pastedTexts.push(text);
    });
    captured.onCharInput = onCharInput;
    return null;
  }

  const instance = render(<Harness />);
  return { captured, instance };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('useBracketedPaste', () => {
  let instance: ReturnType<typeof render> | null = null;
  let stdinHandlers: ((chunk: Buffer) => void)[] = [];

  beforeEach(() => {
    stdinHandlers = [];
    // Mock process.stdin.on to capture handlers.
    vi.spyOn(process.stdin, 'on').mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        if (event === 'data') {
          stdinHandlers.push(handler as (chunk: Buffer) => void);
        }
        return process.stdin;
      }
    );
    // Mock process.stdin.off to track removal.
    vi.spyOn(process.stdin, 'off').mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        if (event === 'data') {
          stdinHandlers = stdinHandlers.filter(h => h !== handler);
        }
        return process.stdin;
      }
    );
  });

  afterEach(() => {
    instance?.cleanup();
    instance = null;
    vi.restoreAllMocks();
  });

  // ── Bracketed paste detection ────────────────────────────────────

  it('detects bracketed paste and delivers content atomically', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    // Simulate a bracketed paste sequence via stdin data event.
    const pasteContent = 'hello\nworld\npasted text';
    const pasteSequence = `\x1b[200~${pasteContent}\x1b[201~`;
    const handler = stdinHandlers[0];
    expect(handler).toBeDefined();
    handler(Buffer.from(pasteSequence, 'utf-8'));
    await tick();

    expect(captured.pastedTexts).toHaveLength(1);
    expect(captured.pastedTexts[0]).toBe(pasteContent);
  });

  it('handles paste content split across multiple chunks', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    const handler = stdinHandlers[0];
    expect(handler).toBeDefined();

    // Send the start marker and part of the content.
    handler(Buffer.from('\x1b[200~part1 ', 'utf-8'));
    await tick();
    expect(captured.pastedTexts).toHaveLength(0); // not yet complete

    // Send the rest of the content and the end marker.
    handler(Buffer.from('part2\x1b[201~', 'utf-8'));
    await tick();

    expect(captured.pastedTexts).toHaveLength(1);
    expect(captured.pastedTexts[0]).toBe('part1 part2');
  });

  it('handles multiple paste sequences', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    const handler = stdinHandlers[0];
    expect(handler).toBeDefined();

    handler(Buffer.from('\x1b[200~first\x1b[201~', 'utf-8'));
    await tick();
    handler(Buffer.from('\x1b[200~second\x1b[201~', 'utf-8'));
    await tick();

    expect(captured.pastedTexts).toHaveLength(2);
    expect(captured.pastedTexts[0]).toBe('first');
    expect(captured.pastedTexts[1]).toBe('second');
  });

  it('ignores non-paste data on stdin', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    const handler = stdinHandlers[0];
    expect(handler).toBeDefined();

    // Send regular keystroke data (not a paste sequence).
    handler(Buffer.from('hello', 'utf-8'));
    await tick();

    // No paste should be delivered.
    expect(captured.pastedTexts).toHaveLength(0);
  });

  it('registers a stdin data listener on mount', async () => {
    const { instance: inst } = createHarness();
    instance = inst;
    await tick();

    // The hook should have registered a 'data' listener on stdin.
    expect(stdinHandlers).toHaveLength(1);
  });

  // ── Debounce fallback ────────────────────────────────────────────

  it('delivers single character immediately via onCharInput (normal typing)', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    captured.onCharInput!('a');
    await tick();

    // Normal typing: character delivered immediately (first char is
    // always "slow" since lastCharTimeRef starts at 0).
    expect(captured.pastedTexts).toHaveLength(1);
    expect(captured.pastedTexts[0]).toBe('a');
  });

  it('buffers rapid characters and flushes after pause', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    // Simulate rapid input by calling onCharInput in quick succession.
    // Since these all happen synchronously, the elapsed time between
    // each call will be 0ms (well under the 30ms threshold).
    // The first character is delivered immediately (lastCharTimeRef
    // starts at 0, so elapsed > 30ms). Subsequent characters are
    // buffered because elapsed = 0ms.
    captured.onCharInput!('h');
    captured.onCharInput!('e');
    captured.onCharInput!('l');
    captured.onCharInput!('l');
    captured.onCharInput!('o');

    // Only the first character should be delivered immediately.
    expect(captured.pastedTexts).toHaveLength(1);
    expect(captured.pastedTexts[0]).toBe('h');

    // Wait for the flush timer (50ms debounce).
    await new Promise(r => setTimeout(r, 60));
    await tick();

    // The remaining buffered characters should be delivered as one string.
    expect(captured.pastedTexts).toHaveLength(2);
    expect(captured.pastedTexts[1]).toBe('ello');
  });

  it('flushes buffer when a slow character arrives', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    // First character is delivered immediately (lastCharTimeRef = 0).
    captured.onCharInput!('a');

    // Rapid characters (synchronous, so elapsed time is 0ms).
    captured.onCharInput!('b');
    captured.onCharInput!('c');

    // Wait long enough for the debounce threshold to be exceeded
    // (30ms) but not so long that the flush timer fires (50ms).
    await new Promise(r => setTimeout(r, 40));

    // This character arrives after the threshold, so it should flush
    // the buffer first, then deliver 'd' separately.
    captured.onCharInput!('d');
    await tick();

    // 'a' was delivered immediately, 'bc' was buffered and flushed
    // by the slow 'd', then 'd' delivered separately.
    expect(captured.pastedTexts).toHaveLength(3);
    expect(captured.pastedTexts[0]).toBe('a');
    expect(captured.pastedTexts[1]).toBe('bc');
    expect(captured.pastedTexts[2]).toBe('d');
  });

  it('does not buffer when bracketed paste is active', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    const handler = stdinHandlers[0];
    expect(handler).toBeDefined();

    // Start a bracketed paste.
    handler(Buffer.from('\x1b[200~pasted', 'utf-8'));
    await tick();

    // While in paste, onCharInput should be a no-op.
    captured.onCharInput!('x');
    await tick();

    // Complete the paste.
    handler(Buffer.from(' content\x1b[201~', 'utf-8'));
    await tick();

    // Only the bracketed paste content should be delivered.
    expect(captured.pastedTexts).toHaveLength(1);
    expect(captured.pastedTexts[0]).toBe('pasted content');
  });

  // ── Line ending normalization ────────────────────────────────────

  it('normalizes \\r\\n to \\n in bracketed paste content', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    const handler = stdinHandlers[0];
    expect(handler).toBeDefined();

    const pasteContent = 'hello\r\nworld\r\nfoo';
    const pasteSequence = `\x1b[200~${pasteContent}\x1b[201~`;
    handler(Buffer.from(pasteSequence, 'utf-8'));
    await tick();

    expect(captured.pastedTexts).toHaveLength(1);
    expect(captured.pastedTexts[0]).toBe('hello\nworld\nfoo');
  });

  it('normalizes bare \\r to \\n in bracketed paste content', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    const handler = stdinHandlers[0];
    expect(handler).toBeDefined();

    const pasteContent = 'hello\rworld\rfoo';
    const pasteSequence = `\x1b[200~${pasteContent}\x1b[201~`;
    handler(Buffer.from(pasteSequence, 'utf-8'));
    await tick();

    expect(captured.pastedTexts).toHaveLength(1);
    expect(captured.pastedTexts[0]).toBe('hello\nworld\nfoo');
  });

  it('normalizes \\r\\n to \\n in debounce fallback path', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    // Simulate rapid input containing \r\n characters.
    captured.onCharInput!('a');
    captured.onCharInput!('\r');
    captured.onCharInput!('\n');
    captured.onCharInput!('b');

    // First char 'a' delivered immediately, rest buffered.
    expect(captured.pastedTexts).toHaveLength(1);
    expect(captured.pastedTexts[0]).toBe('a');

    // Wait for flush.
    await new Promise(r => setTimeout(r, 60));
    await tick();

    // \r\n should be normalized to \n.
    expect(captured.pastedTexts).toHaveLength(2);
    expect(captured.pastedTexts[1]).toBe('\nb');
  });

  it('normalizes bare \\r to \\n in debounce fallback path', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    await tick();

    captured.onCharInput!('a');
    captured.onCharInput!('\r');
    captured.onCharInput!('b');

    expect(captured.pastedTexts).toHaveLength(1);
    expect(captured.pastedTexts[0]).toBe('a');

    await new Promise(r => setTimeout(r, 60));
    await tick();

    expect(captured.pastedTexts).toHaveLength(2);
    expect(captured.pastedTexts[1]).toBe('\nb');
  });
});

/**
 * Tests for the useSgrMouse hook.
 *
 * Covers:
 *   - Enable sequence written on mount
 *   - Parsing of SGR mouse events
 *   - No-op when stdin is not a TTY
 */

import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import {
  useSgrMouse,
  type SgrMouseEvent,
} from '../src/tui/hooks/useSgrMouse.js';

const tick = () => new Promise(r => setTimeout(r, 10));

/**
 * Test harness that renders a component using useSgrMouse and captures
 * the lastClick value via a ref.
 */
function createHarness() {
  const lastClickRef: { current: SgrMouseEvent | null } = { current: null };

  function Harness() {
    const { lastClick } = useSgrMouse();
    lastClickRef.current = lastClick;
    return <Text>test</Text>;
  }

  return { Harness, lastClickRef };
}

describe('useSgrMouse', () => {
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;
  let stdinListeners: Array<(chunk: Buffer) => void> = [];
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    stdinListeners = [];

    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    vi.spyOn(process.stdin, 'on').mockImplementation(
      (event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          stdinListeners.push(listener as (chunk: Buffer) => void);
        }
        return process.stdin;
      }
    );

    vi.spyOn(process.stdin, 'off').mockImplementation(() => process.stdin);

    originalIsTTY = process.stdin.isTTY;
    (process.stdin as { isTTY: boolean | undefined }).isTTY = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (process.stdin as { isTTY: boolean | undefined }).isTTY = originalIsTTY;
  });

  it('writes SGR enable sequence on mount', () => {
    const { Harness } = createHarness();
    const { cleanup } = render(<Harness />);
    expect(stdoutWriteSpy).toHaveBeenCalledWith('\x1b[?1000h\x1b[?1006h');
    cleanup();
  });

  it('parses a left button press event', async () => {
    const { Harness, lastClickRef } = createHarness();
    const { cleanup } = render(<Harness />);

    const event = '\x1b[<10;5;0M';
    for (const listener of stdinListeners) {
      listener(Buffer.from(event, 'utf-8'));
    }
    await tick();

    expect(lastClickRef.current).toEqual({
      row: 10,
      col: 5,
      button: 'left',
      action: 'press',
    });
    cleanup();
  });

  it('parses a right button release event', async () => {
    const { Harness, lastClickRef } = createHarness();
    const { cleanup } = render(<Harness />);

    const event = '\x1b[<3;20;2m';
    for (const listener of stdinListeners) {
      listener(Buffer.from(event, 'utf-8'));
    }
    await tick();

    expect(lastClickRef.current).toEqual({
      row: 3,
      col: 20,
      button: 'right',
      action: 'release',
    });
    cleanup();
  });

  it('parses a middle button press event', async () => {
    const { Harness, lastClickRef } = createHarness();
    const { cleanup } = render(<Harness />);

    const event = '\x1b[<15;8;1M';
    for (const listener of stdinListeners) {
      listener(Buffer.from(event, 'utf-8'));
    }
    await tick();

    expect(lastClickRef.current).toEqual({
      row: 15,
      col: 8,
      button: 'middle',
      action: 'press',
    });
    cleanup();
  });

  it('handles partial sequences across multiple chunks', async () => {
    const { Harness, lastClickRef } = createHarness();
    const { cleanup } = render(<Harness />);

    const chunk1 = '\x1b[<10;5;';
    for (const listener of stdinListeners) {
      listener(Buffer.from(chunk1, 'utf-8'));
    }
    await tick();
    expect(lastClickRef.current).toBeNull();

    const chunk2 = '0M';
    for (const listener of stdinListeners) {
      listener(Buffer.from(chunk2, 'utf-8'));
    }
    await tick();
    expect(lastClickRef.current).toEqual({
      row: 10,
      col: 5,
      button: 'left',
      action: 'press',
    });
    cleanup();
  });

  it('does nothing when stdin is not a TTY', () => {
    (process.stdin as { isTTY: boolean | undefined }).isTTY = false;
    stdoutWriteSpy.mockClear();

    const { Harness } = createHarness();
    const { cleanup } = render(<Harness />);

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    cleanup();
  });
});

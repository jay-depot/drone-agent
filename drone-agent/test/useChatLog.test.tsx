/**
 * Tests for useChatLog — the committed scrollback entry buffer.
 *
 * Focus: `appendEntry` assigns stable monotonic ids (so React keys never
 * collide) and `log` is a shorthand that defaults to kind 'plain'.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { useChatLog } from '../src/tui/hooks/useChatLog.js';

type ChatApi = ReturnType<typeof useChatLog>;

function createHarness() {
  const captured: {
    appendEntry?: ChatApi['appendEntry'];
    log?: ChatApi['log'];
    getEntries: () => ChatApi['entries'];
  } = { getEntries: () => [] };

  function Harness() {
    const h = useChatLog();
    captured.appendEntry = h.appendEntry;
    captured.log = h.log;
    captured.getEntries = () => h.entries;
    return null;
  }

  const instance: ReturnType<typeof render> = render(<Harness />);
  return { captured, instance };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('useChatLog', () => {
  let instance: ReturnType<typeof render> | null = null;
  afterEach(() => {
    instance?.cleanup();
    instance = null;
  });

  it('appendEntry assigns a unique id per entry', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    captured.appendEntry!({ text: 'a', kind: 'info' });
    captured.appendEntry!({ text: 'b', kind: 'error' });
    await tick();

    const entries = captured.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).not.toBe(entries[1].id);
  });

  it('log defaults to kind plain and stores text', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    captured.log!('hello world');
    await tick();

    const entries = captured.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('hello world');
    expect(entries[0].kind).toBe('plain');
  });

  it('log accepts an explicit kind', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    captured.log!('oops', 'error');
    await tick();

    const entries = captured.getEntries();
    expect(entries[0].kind).toBe('error');
  });

  it('appendEntry preserves order', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    captured.appendEntry!({ text: 'first', kind: 'plain' });
    captured.appendEntry!({ text: 'second', kind: 'plain' });
    await tick();

    const texts = captured.getEntries().map(e => e.text);
    expect(texts).toEqual(['first', 'second']);
  });
});

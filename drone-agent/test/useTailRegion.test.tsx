/**
 * Tests for useTailRegion — the live tail buffer that commits items
 * into the <Static> scrollback.
 *
 * The key behavior under test: `commitItem`/`commitAll` must attach the
 * live `component` as `entry.node`, so ChatLog can render the rich
 * component (preserving formatting) instead of only the plain toEntry()
 * string.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { isValidElement } from 'react';
import { useTailRegion } from '../src/tui/hooks/useTailRegion.js';

type TailApi = ReturnType<typeof useTailRegion>;

function createHarness() {
  const captured: {
    addItem?: TailApi['addItem'];
    updateItem?: TailApi['updateItem'];
    commitItem?: TailApi['commitItem'];
    commitAll?: TailApi['commitAll'];
    clear?: TailApi['clear'];
    getItems: () => TailApi['items'];
  } = { getItems: () => [] };

  function Harness() {
    const h = useTailRegion();
    captured.addItem = h.addItem;
    captured.updateItem = h.updateItem;
    captured.commitItem = h.commitItem;
    captured.commitAll = h.commitAll;
    captured.clear = h.clear;
    captured.getItems = () => h.items;
    return null;
  }

  const instance: ReturnType<typeof render> = render(<Harness />);
  return { captured, instance };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('useTailRegion', () => {
  let instance: ReturnType<typeof render> | null = null;
  afterEach(() => {
    instance?.cleanup();
    instance = null;
  });

  it('addItem creates a live item and commitItem returns it with node attached', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    const component = <span data-testid="live">live component</span>;
    const id = captured.addItem!('reasoning', component, () => ({
      text: 'plain text',
      kind: 'reasoning',
    }));
    await tick();

    expect(captured.getItems()).toHaveLength(1);
    expect(id).toBeTruthy();

    const entry = captured.commitItem!(id);
    expect(entry.text).toBe('plain text');
    expect(entry.kind).toBe('reasoning');
    // The live component must be carried into the entry as `node`.
    expect(entry.node).toBeDefined();
    expect(isValidElement(entry.node)).toBe(true);
    expect(entry.node).toBe(component);

    await tick();
    expect(captured.getItems()).toHaveLength(0);
  });

  it('updateItem swaps the live component carried into the committed entry', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    const first = <span>first</span>;
    const second = <span>second</span>;
    const id = captured.addItem!('toolCall', first, () => ({
      text: 'a',
      kind: 'toolCall',
    }));
    await tick();
    captured.updateItem!(id, second, () => ({ text: 'b', kind: 'toolCall' }));
    await tick();

    const entry = captured.commitItem!(id);
    expect(entry.node).toBe(second);
  });

  it('commitItem throws for an unknown id', () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    expect(() => captured.commitItem!('nope')).toThrow();
  });

  it('commitAll commits every item with its node', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    const c1 = <span>one</span>;
    const c2 = <span>two</span>;
    captured.addItem!('reasoning', c1, () => ({
      text: '1',
      kind: 'reasoning',
    }));
    captured.addItem!('toolCall', c2, () => ({ text: '2', kind: 'toolCall' }));
    await tick();

    const entries = captured.commitAll!();
    expect(entries).toHaveLength(2);
    expect(entries[0].node).toBe(c1);
    expect(entries[1].node).toBe(c2);

    await tick();
    expect(captured.getItems()).toHaveLength(0);
  });

  it('clear empties the tail without producing entries', async () => {
    const { captured, instance: inst } = createHarness();
    instance = inst;
    captured.addItem!('reasoning', <span>x</span>, () => ({
      text: 't',
      kind: 'reasoning',
    }));
    await tick();
    expect(captured.getItems()).toHaveLength(1);
    captured.clear!();
    await tick();
    expect(captured.getItems()).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { DroneSessionTurn } from 'drone-core';
import { getDroppableTurnPrefix } from '../src/runtime/turn-utils.js';

function makeTurn(content: string, kind?: 'summary'): DroneSessionTurn {
  return {
    id: content,
    messages: [{ role: 'user', content }],
    kind,
  };
}

describe('getDroppableTurnPrefix', () => {
  it('returns an empty prefix for count <= 0', () => {
    const turns = [makeTurn('a'), makeTurn('b')];
    expect(getDroppableTurnPrefix(turns, 0)).toEqual([]);
    expect(getDroppableTurnPrefix(turns, -3)).toEqual([]);
  });

  it('returns leading non-summary turns up to count', () => {
    const turns = [makeTurn('a'), makeTurn('b'), makeTurn('c')];
    const dropped = getDroppableTurnPrefix(turns, 2);
    expect(dropped.map(t => t.id)).toEqual(['a', 'b']);
  });

  it('stops at the first summary turn and returns fewer than count', () => {
    const turns = [makeTurn('a'), makeTurn('S', 'summary'), makeTurn('b')];
    const dropped = getDroppableTurnPrefix(turns, 5);
    expect(dropped.map(t => t.id)).toEqual(['a']);
  });

  it('returns nothing when the head is a summary turn', () => {
    const turns = [makeTurn('S', 'summary'), makeTurn('a')];
    expect(getDroppableTurnPrefix(turns, 5)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const turns = [makeTurn('a'), makeTurn('b'), makeTurn('c')];
    const snapshot = turns.map(t => t.id);
    getDroppableTurnPrefix(turns, 2);
    expect(turns.map(t => t.id)).toEqual(snapshot);
  });
});

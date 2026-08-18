import { describe, expect, it } from 'vitest';
import type { DroneSessionTurn } from 'drone-core';
import { getOldestNonSummaryTurns } from '../src/runtime/turn-utils.js';

function makeTurn(content: string, kind?: 'summary'): DroneSessionTurn {
  return {
    id: content,
    messages: [{ role: 'user', content }],
    kind,
  };
}

describe('getOldestNonSummaryTurns', () => {
  it('returns an empty array for count <= 0', () => {
    const turns = [makeTurn('a'), makeTurn('b')];
    expect(getOldestNonSummaryTurns(turns, 0)).toEqual([]);
    expect(getOldestNonSummaryTurns(turns, -3)).toEqual([]);
  });

  it('returns the oldest non-summary turns in chronological order up to count', () => {
    const turns = [makeTurn('a'), makeTurn('b'), makeTurn('c')];
    const dropped = getOldestNonSummaryTurns(turns, 2);
    expect(dropped.map(t => t.id)).toEqual(['a', 'b']);
  });

  it('skips summary turns and continues past them', () => {
    const turns = [
      makeTurn('S', 'summary'),
      makeTurn('a'),
      makeTurn('S2', 'summary'),
      makeTurn('b'),
    ];
    const dropped = getOldestNonSummaryTurns(turns, 2);
    expect(dropped.map(t => t.id)).toEqual(['a', 'b']);
  });

  it('returns fewer than count when there are not enough non-summary turns', () => {
    const turns = [makeTurn('S', 'summary'), makeTurn('a')];
    const dropped = getOldestNonSummaryTurns(turns, 5);
    expect(dropped.map(t => t.id)).toEqual(['a']);
  });

  it('returns an empty array when all turns are summaries', () => {
    const turns = [makeTurn('S1', 'summary'), makeTurn('S2', 'summary')];
    expect(getOldestNonSummaryTurns(turns, 5)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const turns = [makeTurn('a'), makeTurn('b'), makeTurn('c')];
    const snapshot = turns.map(t => t.id);
    getOldestNonSummaryTurns(turns, 2);
    expect(turns.map(t => t.id)).toEqual(snapshot);
  });
});

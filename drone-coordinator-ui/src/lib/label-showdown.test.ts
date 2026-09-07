import { describe, expect, it } from 'vitest';
import {
  selectShowdownSurvivors,
  type ShowdownCandidate,
} from './label-showdown';

function candidate(
  id: string,
  score: number,
  rect: [number, number, number, number]
): ShowdownCandidate {
  return {
    id,
    score,
    rect: { x1: rect[0], y1: rect[1], x2: rect[2], y2: rect[3] },
  };
}

describe('selectShowdownSurvivors', () => {
  it('keeps non-overlapping labels regardless of score', () => {
    const survivors = selectShowdownSurvivors([
      candidate('a', 1, [0, 0, 10, 10]),
      candidate('b', 9, [20, 20, 30, 30]),
      candidate('c', 5, [40, 40, 50, 50]),
    ]);
    expect([...survivors].sort()).toEqual(['a', 'b', 'c']);
  });

  it('hides the lower-scored label in a direct duel', () => {
    const survivors = selectShowdownSurvivors([
      candidate('weak', 1, [0, 0, 10, 10]),
      candidate('strong', 9, [5, 5, 15, 15]),
    ]);
    expect([...survivors]).toEqual(['strong']);
  });

  it('hides a label that overlaps ANY higher-ranked candidate, even a culled one (no chain rescue)', () => {
    // strong overlaps mid; mid overlaps weak; strong and weak do not overlap.
    const survivors = selectShowdownSurvivors([
      candidate('weak', 1, [20, 0, 30, 10]),
      candidate('mid', 5, [9, 0, 21, 10]),
      candidate('strong', 9, [0, 0, 10, 10]),
    ]);
    expect([...survivors]).toEqual(['strong']);
  });

  it('resolves ties by list position deterministically (ascending id)', () => {
    const survivors = selectShowdownSurvivors([
      candidate('b', 5, [0, 0, 10, 10]),
      candidate('a', 5, [5, 5, 15, 15]),
    ]);
    expect([...survivors]).toEqual(['a']);
    // Input order must not matter for equal scores.
    const reordered = selectShowdownSurvivors([
      candidate('a', 5, [5, 5, 15, 15]),
      candidate('b', 5, [0, 0, 10, 10]),
    ]);
    expect([...reordered]).toEqual(['a']);
  });

  it('lets a survivor coexist with overlapping weaker labels it does not touch', () => {
    const survivors = selectShowdownSurvivors([
      candidate('hub', 10, [0, 0, 10, 10]),
      candidate('far', 1, [50, 50, 60, 60]),
      candidate('near', 2, [8, 8, 18, 18]),
    ]);
    expect([...survivors].sort()).toEqual(['far', 'hub']);
  });

  it('returns an empty set for no candidates', () => {
    expect(selectShowdownSurvivors([]).size).toBe(0);
  });

  it('treats edge-touching rectangles as non-overlapping', () => {
    const survivors = selectShowdownSurvivors([
      candidate('a', 5, [0, 0, 10, 10]),
      candidate('b', 1, [10, 0, 20, 10]),
    ]);
    expect([...survivors].sort()).toEqual(['a', 'b']);
  });
});

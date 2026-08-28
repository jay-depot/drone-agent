import type { DroneSessionTurn } from 'drone-core';

/**
 * Return the oldest non-summary turns in chronological order, up to `count`,
 * skipping any summary turns. Returns fewer than `count` when there are not
 * enough non-summary turns. Pure — does not mutate `turns`.
 */
export function getOldestNonSummaryTurns(
  turns: DroneSessionTurn[],
  count: number
): DroneSessionTurn[] {
  if (count <= 0) {
    return [];
  }

  const oldest: DroneSessionTurn[] = [];
  for (const turn of turns) {
    if (oldest.length >= count) {
      break;
    }
    if (turn.kind === 'summary') {
      continue;
    }
    oldest.push(turn);
  }
  return oldest;
}

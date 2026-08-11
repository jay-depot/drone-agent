import type { DroneSessionTurn } from 'drone-core';

/**
 * Return the longest leading prefix of `turns` that safety trimming may drop:
 * non-summary turns from the head, up to `count`, stopping before the first
 * summary turn. Pure — does not mutate `turns`.
 */
export function getDroppableTurnPrefix(
  turns: DroneSessionTurn[],
  count: number
): DroneSessionTurn[] {
  if (count <= 0) {
    return [];
  }

  const dropped: DroneSessionTurn[] = [];
  for (const turn of turns) {
    if (dropped.length >= count || turn.kind === 'summary') {
      break;
    }
    dropped.push(turn);
  }
  return dropped;
}

/**
 * Shared utilities for maintaining sorted registries of providers and writers.
 * Used by the skills and persona broker plugins to keep their provider/writer
 * lists in precedence/scope order.
 */

const SCOPE_ORDER: Record<string, number> = {
  project: 0,
  user: 1,
  beacon: 2,
  coordinator: 3,
};

/**
 * Insert an item into a sorted array, maintaining ascending precedence order.
 * Items with lower precedence numbers come first (higher priority).
 */
export function insertSortedByPrecedence<
  T extends { id: string; precedence: number },
>(items: T[], item: T): void {
  const idx = items.findIndex(p => p.precedence > item.precedence);
  if (idx === -1) {
    items.push(item);
  } else {
    items.splice(idx, 0, item);
  }
}

/**
 * Remove an item from an array by id.
 */
export function removeById<T extends { id: string }>(
  items: T[],
  id: string
): void {
  const idx = items.findIndex(p => p.id === id);
  if (idx !== -1) {
    items.splice(idx, 1);
  }
}

/**
 * Insert a writer into a sorted array, maintaining scope order:
 * project (0), user (1), beacon (2), coordinator (3).
 */
export function insertWriterSorted<T extends { id: string; scope: string }>(
  items: T[],
  item: T
): void {
  const order = SCOPE_ORDER[item.scope] ?? 99;
  const idx = items.findIndex(w => (SCOPE_ORDER[w.scope] ?? 99) > order);
  if (idx === -1) {
    items.push(item);
  } else {
    items.splice(idx, 0, item);
  }
}

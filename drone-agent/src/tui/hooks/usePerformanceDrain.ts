/**
 * Periodically drains the global User Timing performance buffer.
 *
 * React's reconciler development build records a `performance.measure` entry
 * for every component render/commit and never clears them. In a long-lived
 * Ink app (ours is), the global buffer fills to Node's 1,000,000-entry cap
 * and then warns with MaxPerformanceEntryBufferExceededWarning, holding a
 * large amount of unreclaimable memory. This hook bounds the growth.
 */

import { useEffect } from 'react';

const MAX_MEASURES = 100_000;

export function usePerformanceDrain(intervalMs = 60_000): void {
  useEffect(() => {
    if (
      typeof performance === 'undefined' ||
      typeof performance.clearMeasures !== 'function'
    ) {
      return;
    }

    const interval = setInterval(() => {
      // getEntriesByType copies the matched entries; the count alone tells
      // us whether to drain. Cost per tick is proportional to the entry
      // count (≤ 100k) and runs off the hot path.
      const count = performance.getEntriesByType('measure').length;
      if (count >= MAX_MEASURES) {
        performance.clearMeasures();
      }
    }, intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs]);
}

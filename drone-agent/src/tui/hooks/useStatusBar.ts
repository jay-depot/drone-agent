/**
 * Hook for refreshing status bar data.
 *
 * Polls context usage percentage and cwd on a soft interval.
 * cwd is cheap to read but we still coalesce to one timer
 * so we don't pile up microtasks.
 */

import { useEffect, useState } from 'react';

export function useStatusBar(
  getEstimatedContextUsagePercent: () => Promise<number>,
  entriesLength: number
): {
  ctxPct: number | null;
  cwd: string;
} {
  const [ctxPct, setCtxPct] = useState<number | null>(null);
  const [cwd, setCwd] = useState<string>(process.cwd());

  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      setCwd(process.cwd());
      getEstimatedContextUsagePercent()
        .then(pct => {
          if (!cancelled) setCtxPct(pct);
        })
        .catch(() => {
          if (!cancelled) setCtxPct(null);
        });
    };
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [getEstimatedContextUsagePercent, entriesLength]);

  return { ctxPct, cwd };
}

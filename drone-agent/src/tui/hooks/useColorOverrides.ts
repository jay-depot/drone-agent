/**
 * Hook for managing the color override stack and cycling timer.
 *
 * The base scheme is grayscale. Plugins push overrides onto a stack;
 * the TUI cycles through them on a timer. When an override is "done",
 * the plugin that pushed it must pop it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_GRAYSCALE_SCHEME,
  applyTint,
  type DroneColorOverride,
  type DroneColorScheme,
} from '../theme.js';

/** How long each override gets to be the active tint. */
const COLOR_CYCLE_INTERVAL_MS = 5_000;

export function useColorOverrides(): {
  scheme: DroneColorScheme;
  pushColorOverride: (override: DroneColorOverride) => void;
  popColorOverride: (overrideId: string) => void;
} {
  const [overrides, setOverrides] = useState<DroneColorOverride[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const activeOverride = overrides[activeIndex];
  const scheme: DroneColorScheme = useMemo(() => {
    if (!activeOverride) return DEFAULT_GRAYSCALE_SCHEME;
    return applyTint(DEFAULT_GRAYSCALE_SCHEME, activeOverride.tint);
  }, [activeOverride]);

  // Cycle timer: bump the active index every COLOR_CYCLE_INTERVAL_MS.
  useEffect(() => {
    if (overrides.length === 0) return;
    const id = setInterval(() => {
      setActiveIndex(prev => (prev + 1) % overrides.length);
    }, COLOR_CYCLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [overrides.length]);

  // If overrides get popped and the active index is now out of range,
  // wrap it back to 0.
  useEffect(() => {
    if (overrides.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
    } else if (activeIndex >= overrides.length) {
      setActiveIndex(0);
    }
  }, [overrides.length, activeIndex]);

  const pushColorOverride = useCallback((override: DroneColorOverride) => {
    setOverrides(prev => {
      const existingIdx = prev.findIndex(o => o.id === override.id);
      if (existingIdx !== -1) {
        const next = prev.slice();
        next[existingIdx] = override;
        return next;
      }
      return [...prev, override];
    });
  }, []);

  const popColorOverride = useCallback((overrideId: string) => {
    setOverrides(prev => {
      const idx = prev.findIndex(o => o.id === overrideId);
      if (idx === -1) return prev;
      const next = prev.slice();
      next.splice(idx, 1);
      return next;
    });
  }, []);

  return { scheme, pushColorOverride, popColorOverride };
}

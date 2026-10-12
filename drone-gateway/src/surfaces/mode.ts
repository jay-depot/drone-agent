export type SurfaceMode = 'active' | 'passive' | 'observer';

export const SURFACE_MODES: readonly SurfaceMode[] = [
  'active',
  'passive',
  'observer',
];

export const DEFAULT_SURFACE_MODE: SurfaceMode = 'active';

/** Observer/passive periodic catch-up cadence (ms) when nothing else is set. */
export const DEFAULT_CATCH_UP_INTERVAL_MS = 900_000;

export function isSurfaceMode(value: unknown): value is SurfaceMode {
  return (
    typeof value === 'string' &&
    (SURFACE_MODES as readonly string[]).includes(value)
  );
}

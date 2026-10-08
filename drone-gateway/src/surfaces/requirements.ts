import type { ControlSurfaceSpec } from '../types.js';

export type SurfaceSpawnMode = 'local' | 'coordinator';

/** Surface types that spawn agents and therefore may name a target beacon. */
export const SPAWNING_SURFACES: ReadonlySet<string> = new Set([
  'persona-assignment',
]);

/**
 * Surface types that require a coordinator connection, whether or not they
 * spawn agents (e.g. a surface that calls coordinator REST endpoints directly).
 */
export const SURFACES_REQUIRING_COORDINATOR: ReadonlySet<string> = new Set([
  'swarm-console',
]);

/**
 * A surface's spawn mode is inferred: a surface that names a
 * `config.targetBeaconId` spawns via the coordinator on that beacon; any other
 * surface spawns locally.
 */
export function resolveSurfaceSpawnMode(
  spec: ControlSurfaceSpec
): SurfaceSpawnMode {
  const beacon = spec.config?.targetBeaconId;
  return typeof beacon === 'string' && beacon.trim() !== ''
    ? 'coordinator'
    : 'local';
}

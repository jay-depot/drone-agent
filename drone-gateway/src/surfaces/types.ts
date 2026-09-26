import type { ControlSurfaceSpec, DroneControlSurface } from '../types.js';
import type { SpawnBackend } from '../spawn-backend.js';
import type { SwarmApi } from '../console/swarm-api.js';

/**
 * Everything a control surface factory is allowed to depend on. Formalizing
 * this keeps surfaces from reaching into engine internals.
 */
export interface SurfaceContext {
  spawnBackend: SpawnBackend;
  /** Undefined in local spawn-backend mode (no coordinator to talk to). */
  swarm: SwarmApi | undefined;
  /**
   * Resolved by the engine: the conversation's
   * `controlSurfaces[].config.targetBeaconId` if valid, otherwise the
   * gateway-wide default. Absent in local spawn-backend mode.
   */
  targetBeaconId?: string;
}

export type SurfaceFactory = (
  spec: ControlSurfaceSpec,
  conversationId: string,
  ctx: SurfaceContext
) => DroneControlSurface;

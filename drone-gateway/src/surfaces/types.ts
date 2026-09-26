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
}

export type SurfaceFactory = (
  spec: ControlSurfaceSpec,
  conversationId: string,
  ctx: SurfaceContext
) => DroneControlSurface;

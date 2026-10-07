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
  /**
   * Engine-resolved per-surface working directory (validated at load).
   * Absent means "use the default": local mode inherits the gateway cwd;
   * coordinator mode lets the beacon apply its `defaultSpawnRoot`.
   */
  workingDir?: string;
  /**
   * Engine-resolved idle timeout in ms (`config.lifecycle.idleTimeoutMs` ??
   * gateway-wide `idleTimeoutMs`). `0` disables. Defaults are applied by
   * SessionLifecycle when this is absent.
   */
  idleTimeoutMs?: number;
  /**
   * Engine-resolved batch debounce in ms (`config.batch.debounceMs` ??
   * gateway-wide `batch.debounceMs`). `0` disables the debounce. Defaults are
   * applied by the engine's MessageBatcher when this is absent. Inert in a
   * multi-surface conversation (batching is single-surface only).
   */
  debounceMs?: number;
}

export type SurfaceFactory = (
  spec: ControlSurfaceSpec,
  conversationId: string,
  ctx: SurfaceContext
) => DroneControlSurface;

import type {
  SpawnSession,
  SpawnBackendType,
  SpawnSessionOptions,
} from './types.js';

/**
 * Pluggable spawn backend interface.
 *
 * Implementations manage the lifecycle of persistent agent processes
 * for the gateway. Two implementations are provided:
 *
 * - `LocalSpawnBackend`: spawns `drone-agent` processes on the host
 * - `CoordinatorSpawnBackend`: delegates to the coordinator's web port
 */
export interface SpawnBackend {
  readonly type: SpawnBackendType;

  /**
   * Spawn a new persistent agent session for a conversation.
   * If a session already exists for this conversation, it should be
   * returned (idempotent).
   *
   * Callers in coordinator mode must supply `opts.targetBeaconId`.
   * Implementations may ignore `opts` when beacon targeting is not
   * applicable (local mode).
   */
  spawnSession(
    conversationId: string,
    personaId: string,
    opts?: SpawnSessionOptions
  ): Promise<SpawnSession>;

  /**
   * Send a message to an existing agent session and return the response.
   * The implementation waits for the agent to complete its turn before
   * returning (i.e., it waits for the `turnComplete` event).
   */
  sendMessage(session: SpawnSession, message: string): Promise<string>;

  /**
   * Terminate an agent session and clean up resources.
   */
  terminateSession(session: SpawnSession): Promise<void>;
}

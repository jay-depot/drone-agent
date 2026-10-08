import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import type { CoordinatorClient } from './coordinator-client.js';
import type { SpawnBackend } from './spawn-backend.js';
import type { SpawnSession, SpawnSessionOptions } from './types.js';

/**
 * CoordinatorSpawnBackend delegates agent spawning to the coordinator's
 * web port. It uses the CoordinatorClient to spawn agents on remote
 * beacons and manage their lifecycle.
 *
 * For persistent sessions, the coordinator tracks agent state and
 * provides message relay via its WebSocket-based messaging system.
 */
export class CoordinatorSpawnBackend implements SpawnBackend {
  readonly type = 'coordinator' as const;

  private coordinatorClient: CoordinatorClient;
  private sessions: Map<string, SpawnSession> = new Map();
  private pending: Map<string, Promise<SpawnSession>> = new Map();

  constructor(coordinatorClient: CoordinatorClient) {
    this.coordinatorClient = coordinatorClient;
  }

  async spawnSession(
    conversationId: string,
    personaId: string,
    opts?: SpawnSessionOptions
  ): Promise<SpawnSession> {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      return existing;
    }

    // Concurrent callers for one conversation share a single in-flight spawn
    // so no two agents are created for the same session.
    const inFlight = this.pending.get(conversationId);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.startSession(conversationId, personaId, opts);
    this.pending.set(conversationId, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(conversationId);
    }
  }

  private async startSession(
    conversationId: string,
    personaId: string,
    opts: SpawnSessionOptions | undefined
  ): Promise<SpawnSession> {
    const targetBeaconId = opts?.targetBeaconId;
    if (!targetBeaconId) {
      throw new Error(
        'CoordinatorSpawnBackend.spawnSession requires a targetBeaconId.'
      );
    }

    const workingDir = opts?.workingDir;

    logger.info(
      `Spawning agent on beacon "${targetBeaconId}" for conversation ${conversationId} (persona: ${personaId})`
    );

    const spawnId = randomUUID();
    const result = await this.coordinatorClient.spawnAgent({
      targetBeaconId,
      personaId,
      spawnId,
      // When no working dir is set, omit `config` entirely so the beacon
      // applies its own `defaultSpawnRoot`.
      ...(workingDir ? { config: { workingDir } } : {}),
    });

    const spawnResult = result as {
      spawnId: string;
      agentId: string;
      status: string;
    };

    const session: SpawnSession = {
      conversationId,
      personaId,
      processId: spawnResult.agentId || spawnResult.spawnId,
      startedAt: Date.now(),
      targetBeaconId,
      spawnId: spawnResult.spawnId,
      workingDir,
    };

    this.sessions.set(conversationId, session);
    return session;
  }

  async sendMessage(
    session: SpawnSession,
    message: string
  ): Promise<string | null> {
    logger.info(
      `Sending message to agent ${session.processId} via coordinator`
    );
    // Deliver the turn as a real user message (the same path the coordinator UI
    // uses). The receive path is not implemented yet — the gateway has no WS
    // subscription to observe the agent's reply — so there is no synchronous
    // reply. Return null so the surface posts nothing instead of posting the
    // delivery ack as the reply.
    await this.coordinatorClient.sendSessionMessage(
      session.processId,
      message,
      false
    );

    return null;
  }

  async terminateSession(session: SpawnSession): Promise<void> {
    logger.info(`Terminating agent ${session.processId} via coordinator`);

    if (!session.targetBeaconId) {
      logger.warn(
        `Cannot terminate agent ${session.processId}: no target beacon recorded on the session`
      );
      this.sessions.delete(session.conversationId);
      return;
    }
    if (!session.spawnId) {
      logger.warn(
        `Cannot terminate agent ${session.processId}: no spawn id recorded on the session`
      );
      this.sessions.delete(session.conversationId);
      return;
    }

    try {
      // The terminate endpoint is keyed on the beacon's spawnId, NOT the
      // agentId (processId). Passing the agentId here 404s at the beacon.
      await this.coordinatorClient.terminateSpawn(
        session.targetBeaconId,
        session.spawnId
      );
    } catch (err) {
      logger.warn(`Failed to terminate agent ${session.processId}: ${err}`);
    }

    this.sessions.delete(session.conversationId);
  }
}

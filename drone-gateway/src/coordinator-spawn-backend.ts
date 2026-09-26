import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { CoordinatorClient } from './coordinator-client.js';
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

  constructor(coordinatorUrl: string, coordinatorToken: string | undefined) {
    this.coordinatorClient = new CoordinatorClient(
      coordinatorUrl,
      coordinatorToken
    );
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

    const targetBeaconId = opts?.targetBeaconId;
    if (!targetBeaconId) {
      throw new Error(
        'CoordinatorSpawnBackend.spawnSession requires a targetBeaconId.'
      );
    }

    logger.info(
      `Spawning agent on beacon "${targetBeaconId}" for conversation ${conversationId} (persona: ${personaId})`
    );

    const spawnId = randomUUID();
    const result = await this.coordinatorClient.spawnAgent({
      targetBeaconId,
      personaId,
      spawnId,
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
    };

    this.sessions.set(conversationId, session);
    return session;
  }

  async sendMessage(session: SpawnSession, message: string): Promise<string> {
    logger.info(
      `Sending message to agent ${session.processId} via coordinator`
    );

    const response = await this.coordinatorClient.sendMessage(
      session.processId,
      message
    );

    return response as string;
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

    try {
      await this.coordinatorClient.terminateSpawn(
        session.targetBeaconId,
        session.processId
      );
    } catch (err) {
      logger.warn(`Failed to terminate agent ${session.processId}: ${err}`);
    }

    this.sessions.delete(session.conversationId);
  }
}

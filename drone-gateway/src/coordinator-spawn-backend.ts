import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { CoordinatorClient } from './coordinator-client.js';
import type { SpawnBackend } from './spawn-backend.js';
import type { SpawnSession } from './types.js';

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
  private targetBeaconId: string;

  constructor(
    coordinatorUrl: string,
    coordinatorToken: string | undefined,
    targetBeaconId?: string
  ) {
    this.coordinatorClient = new CoordinatorClient(
      coordinatorUrl,
      coordinatorToken
    );
    this.targetBeaconId = targetBeaconId || 'default';
  }

  async spawnSession(
    conversationId: string,
    personaId: string
  ): Promise<SpawnSession> {
    // Return existing session if one exists
    const existing = this.sessions.get(conversationId);
    if (existing) {
      return existing;
    }

    logger.info(
      `Spawning agent on coordinator for conversation ${conversationId} (persona: ${personaId})`
    );

    const spawnId = randomUUID();
    const result = await this.coordinatorClient.spawnAgent(
      this.targetBeaconId,
      {
        personaId,
        spawnId,
      }
    );

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
    };

    this.sessions.set(conversationId, session);
    return session;
  }

  async sendMessage(session: SpawnSession, message: string): Promise<string> {
    // For coordinator mode, we send a message to the agent via the
    // coordinator's message relay. The agent processes it and responds.
    // This is a simplified implementation — full persistent session
    // support via the coordinator requires the coordinator's messaging
    // system to be fully operational.
    logger.info(
      `Sending message to agent ${session.processId} via coordinator`
    );

    // Send the message to the agent via the coordinator's message API
    // The coordinator routes it to the appropriate beacon/agent
    const response = await this.coordinatorClient.sendMessage(
      session.processId,
      message
    );

    return response as string;
  }

  async terminateSession(session: SpawnSession): Promise<void> {
    logger.info(`Terminating agent ${session.processId} via coordinator`);

    try {
      await this.coordinatorClient.terminateSpawn(
        this.targetBeaconId,
        session.processId
      );
    } catch (err) {
      logger.warn(`Failed to terminate agent ${session.processId}: ${err}`);
    }

    this.sessions.delete(session.conversationId);
  }
}

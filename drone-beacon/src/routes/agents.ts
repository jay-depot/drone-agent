import type { FastifyInstance } from 'fastify';
import type { RegisterAgentRequest } from '../types.js';
import { getCoordinatorClient } from './context.js';
import { isAgentConnected } from '../ws-server.js';
import { removeAgent } from '../agent-removal.js';
import type { AgentSession } from '../types.js';
import { BROADCAST_TARGET } from 'drone-core';
import {
  getPendingCoordinatorFingerprint,
  getBeaconVerificationCode,
  isBeaconApproved,
  isCoordinatorTrusted,
} from '../coordinator-trust.js';
import * as db from '../db/index.js';

import { logger } from '../logger.js';

/**
 * Derive liveness at read time. The socket map is the authority for "reachable
 * now". The stored column is left alone; the reaper owns deletion.
 */
function withLiveness(agent: AgentSession): AgentSession & { live: boolean } {
  const live = isAgentConnected(agent.id);
  return { ...agent, status: live ? 'connected' : 'disconnected', live };
}

export default function agentRoutes(app: FastifyInstance) {
  // Register an agent session
  app.post<{ Body: RegisterAgentRequest }>(
    '/agents',
    async (request, reply) => {
      if (request.body?.id === BROADCAST_TARGET) {
        return reply.code(400).send({
          error: `'${BROADCAST_TARGET}' is a reserved fragment target and cannot be used as an agentId`,
        });
      }

      const session = db.registerAgent(request.body);

      // If this agent was spawned by the beacon, update the spawn record
      const spawnRecord = db.getSpawnByAgentId(request.body.id);
      if (spawnRecord) {
        db.updateSpawnStatus(spawnRecord.id, 'running', request.body.id);
        logger.info(
          `Spawn ${spawnRecord.id} agent connected: ${request.body.id}`
        );
      }

      // Sync session to coordinator
      const client = getCoordinatorClient();
      if (client) {
        client
          .registerSession(request.body.id, request.body.personaId)
          .catch(err => {
            logger.warn(`Failed to sync session to coordinator: ${err}`);
          });
      }

      // Log the event
      db.createEventLog({
        eventType: 'agent.connected',
        agentId: request.body.id,
        targetId: spawnRecord?.id ?? null,
        targetType: spawnRecord ? 'spawn' : null,
      });

      return reply.code(201).send({
        ...session,
        coordinatorTrust: {
          fingerprintTrusted: isCoordinatorTrusted(),
          beaconApproved: isBeaconApproved(),
          pendingFingerprint: getPendingCoordinatorFingerprint() ?? null,
          verificationCode: getBeaconVerificationCode() ?? null,
        },
      });
    }
  );

  // List active agents
  app.get('/agents', async () => {
    return db.listAgents().map(withLiveness);
  });

  // Get agent info
  app.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const agent = db.getAgent(request.params.id);
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' });
    }
    return withLiveness(agent);
  });

  // Agent heartbeat
  app.post<{ Params: { id: string }; Body?: { personaId?: string | null } }>(
    '/agents/:id/heartbeat',
    async request => {
      const personaId = request.body?.personaId ?? null;
      return db.heartbeatAgent(request.params.id, personaId);
    }
  );

  // Unregister agent
  app.delete<{ Params: { id: string } }>(
    '/agents/:id',
    async (request, reply) => {
      const result = await removeAgent(request.params.id);
      if (!result.removed) {
        return reply.code(404).send({ error: 'Agent not found' });
      }
      return { success: true };
    }
  );

  // PATCH /agents/:id/persona - Update agent persona
  app.patch<{
    Params: { id: string };
    Body: { personaId: string | null };
  }>('/agents/:id/persona', async (request, reply) => {
    const { personaId } = request.body;
    const agent = db.getAgent(request.params.id);
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' });
    }

    // Update local beacon session
    const updated = db.updateAgentPersona(request.params.id, personaId);

    // Sync to coordinator
    const client = getCoordinatorClient();
    if (client) {
      client
        .updateSwarmSessionPersona(request.params.id, personaId)
        .catch(err => {
          logger.warn(`Failed to sync persona to coordinator: ${err}`);
        });
    }

    return reply.send(updated);
  });
}

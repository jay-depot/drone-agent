import type { FastifyInstance } from 'fastify';
import type { RegisterAgentRequest } from '../types.js';
import { getCoordinatorClient } from './context.js';
import * as db from '../db.js';
import * as wsServer from '../ws-server.js';
import { logger } from '../logger.js';

export default function agentRoutes(app: FastifyInstance) {
  // Register an agent session
  app.post<{ Body: RegisterAgentRequest }>(
    '/agents',
    async (request, reply) => {
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

      return reply.code(201).send(session);
    }
  );

  // List active agents
  app.get('/agents', async () => {
    return db.listAgents();
  });

  // Get agent info
  app.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const agent = db.getAgent(request.params.id);
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' });
    }
    return agent;
  });

  // Agent heartbeat
  app.post<{ Params: { id: string } }>(
    '/agents/:id/heartbeat',
    async (request, reply) => {
      const agent = db.updateAgentActivity(request.params.id);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }
      return agent;
    }
  );

  // Unregister agent
  app.delete<{ Params: { id: string } }>(
    '/agents/:id',
    async (request, reply) => {
      // Get agent info before unregistering (for session sync)
      const agent = db.getAgent(request.params.id);
      const connectedAt = agent?.connectedAt ?? Date.now();

      const deleted = db.unregisterAgent(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      // Sync session end to coordinator
      const client = getCoordinatorClient();
      if (client) {
        client.endSession(request.params.id, connectedAt).catch(err => {
          logger.warn(`Failed to sync session end to coordinator: ${err}`);
        });
      }

      // Log the event
      db.createEventLog({
        eventType: 'agent.disconnected',
        agentId: request.params.id,
        metadata: { connectedAt, durationMs: Date.now() - connectedAt },
      });
      return { success: true };
    }
  );
}

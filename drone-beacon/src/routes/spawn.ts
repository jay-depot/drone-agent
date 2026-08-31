import type { FastifyInstance } from 'fastify';
import type { SpawnRequest } from '../types.js';
import {
  handleSpawnAgent,
  handleListSpawns,
  handleGetSpawn,
  handleTerminateSpawn,
} from './spawn-handlers.js';

export default function spawnRoutes(app: FastifyInstance) {
  app.post<{ Body: SpawnRequest }>('/spawn', async (request, reply) => {
    const { status, body } = await handleSpawnAgent(request.body);
    return reply.code(status).send(body);
  });

  app.get<{ Querystring: { status?: string } }>(
    '/spawn',
    async (request, _reply) => {
      return handleListSpawns(request.query.status);
    }
  );

  app.get<{ Params: { spawnId: string } }>(
    '/spawn/:spawnId',
    async (request, reply) => {
      const { status, body } = handleGetSpawn(request.params.spawnId);
      return reply.code(status).send(body);
    }
  );

  app.delete<{ Params: { spawnId: string } }>(
    '/spawn/:spawnId',
    async (request, reply) => {
      const { status, body } = handleTerminateSpawn(request.params.spawnId);
      return reply.code(status).send(body);
    }
  );
}

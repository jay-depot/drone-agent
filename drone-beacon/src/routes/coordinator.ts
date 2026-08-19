import type { FastifyInstance } from 'fastify';
import { getCoordinatorClient } from './context.js';

/**
 * Beacon proxy routes for the agent's coordinator tools.
 *
 * The agent hits these beacon routes instead of the coordinator directly, so
 * the beacon is the sole coordinator-facing trust gate. The beacon forwards
 * to the coordinator via its typed CoordinatorClient and passes the response
 * through unchanged (no reshaping).
 */
export default function coordinatorRoutes(app: FastifyInstance) {
  // List beacons
  app.get('/coordinator/beacons', async (_request, reply) => {
    const client = getCoordinatorClient();
    if (!client) {
      return reply.code(503).send({ error: 'Coordinator not configured' });
    }
    return client.listBeacons();
  });

  // List agent locations (optionally filtered by beacon)
  app.get<{ Querystring: { beaconId?: string } }>(
    '/coordinator/agents/location',
    async (request, reply) => {
      const client = getCoordinatorClient();
      if (!client) {
        return reply.code(503).send({ error: 'Coordinator not configured' });
      }
      return client.listAgentLocations(request.query.beaconId);
    }
  );

  // Spawn an agent on a target beacon (via the coordinator)
  app.post<{ Body: Record<string, unknown> }>(
    '/coordinator/spawn',
    async (request, reply) => {
      const client = getCoordinatorClient();
      if (!client) {
        return reply.code(503).send({ error: 'Coordinator not configured' });
      }
      const result = await client.spawnSpawn(request.body);
      if (result === null) {
        return reply.code(503).send({ error: 'Coordinator unavailable' });
      }
      return result;
    }
  );

  // Get spawn status
  app.get<{ Params: { beaconId: string; spawnId: string } }>(
    '/coordinator/spawn/:beaconId/:spawnId',
    async (request, reply) => {
      const client = getCoordinatorClient();
      if (!client) {
        return reply.code(503).send({ error: 'Coordinator not configured' });
      }
      const result = await client.getSpawn(
        request.params.beaconId,
        request.params.spawnId
      );
      if (result === null) {
        return reply.code(503).send({ error: 'Coordinator unavailable' });
      }
      return result;
    }
  );

  // List spawns on a beacon (optionally filtered by status)
  app.get<{
    Params: { beaconId: string };
    Querystring: { status?: string };
  }>('/coordinator/spawn/:beaconId', async (request, reply) => {
    const client = getCoordinatorClient();
    if (!client) {
      return reply.code(503).send({ error: 'Coordinator not configured' });
    }
    return client.listSpawns(request.params.beaconId, request.query.status);
  });

  // Terminate a spawned agent
  app.delete<{ Params: { beaconId: string; spawnId: string } }>(
    '/coordinator/spawn/:beaconId/:spawnId',
    async (request, reply) => {
      const client = getCoordinatorClient();
      if (!client) {
        return reply.code(503).send({ error: 'Coordinator not configured' });
      }
      const result = await client.terminateSpawn(
        request.params.beaconId,
        request.params.spawnId
      );
      if (result === null) {
        return reply.code(503).send({ error: 'Coordinator unavailable' });
      }
      return result;
    }
  );
}

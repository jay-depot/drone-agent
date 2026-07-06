import type { FastifyInstance } from 'fastify';
import * as db from '../db.js';
import type { SpawnRequest } from '../types.js';

export default function spawnRoutes(app: FastifyInstance) {
  app.post<{ Body: SpawnRequest }>('/spawn', async (request, reply) => {
    const { targetBeaconId, personaId, task, config, spawnId } = request.body;

    // Validate required field
    if (!targetBeaconId) {
      return reply.code(400).send({
        error: 'targetBeaconId is required',
      });
    }

    // Look up the target beacon
    const beacon = db.getBeacon(targetBeaconId);
    if (!beacon) {
      return reply.code(404).send({
        error: 'Target beacon not found',
        code: 'BEACON_NOT_FOUND',
      });
    }

    // Forward the spawn request to the beacon
    try {
      const targetUrl = `http://${beacon.host}:${beacon.port}`;
      const response = await fetch(`${targetUrl}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaId, task, config, spawnId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return reply.code(502).send({
          error: 'Failed to spawn agent on target beacon',
          details: errorText,
        });
      }

      const spawnData = (await response.json()) as Record<string, unknown>;
      return {
        ...spawnData,
        targetBeaconId,
      };
    } catch (err) {
      return reply.code(503).send({
        error: 'Target beacon unavailable',
        details: err instanceof Error ? err.message : 'Unknown error',
        code: 'BEACON_UNAVAILABLE',
      });
    }
  });
}

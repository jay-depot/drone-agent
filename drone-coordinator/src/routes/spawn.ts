import type { FastifyInstance } from 'fastify';
import * as db from '../db/index.js';
import type { SpawnRequest } from '../types.js';

function buildBeaconUrl(
  beacon: { host: string; port: number },
  pathname: string,
  searchParams?: Record<string, string | undefined>
) {
  const url = new URL('http://127.0.0.1');
  url.hostname = beacon.host;
  url.port = String(beacon.port);
  url.pathname = pathname;

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
  }

  return url;
}

export default function spawnRoutes(app: FastifyInstance) {
  // ── Spawn an agent on a target beacon ──────────────────────────────

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
      const response = await fetch(buildBeaconUrl(beacon, '/spawn'), {
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

  // ── List spawns on a beacon ────────────────────────────────────────

  app.get<{
    Params: { beaconId: string };
    Querystring: { status?: string };
  }>('/spawn/:beaconId', async (request, reply) => {
    const beacon = db.getBeacon(request.params.beaconId);
    if (!beacon) {
      return reply
        .code(404)
        .send({ error: 'Beacon not found', code: 'BEACON_NOT_FOUND' });
    }

    try {
      const response = await fetch(
        buildBeaconUrl(beacon, '/spawn', { status: request.query.status })
      );
      if (!response.ok) {
        return reply
          .code(502)
          .send({ error: 'Beacon error', details: await response.text() });
      }
      return response.json();
    } catch (err) {
      return reply.code(503).send({
        error: 'Beacon unavailable',
        code: 'BEACON_UNAVAILABLE',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // ── Get spawn status ───────────────────────────────────────────────

  app.get<{ Params: { beaconId: string; spawnId: string } }>(
    '/spawn/:beaconId/:spawnId',
    async (request, reply) => {
      const beacon = db.getBeacon(request.params.beaconId);
      if (!beacon) {
        return reply
          .code(404)
          .send({ error: 'Beacon not found', code: 'BEACON_NOT_FOUND' });
      }

      try {
        const response = await fetch(
          buildBeaconUrl(beacon, `/spawn/${request.params.spawnId}`)
        );
        if (!response.ok) {
          return reply
            .code(502)
            .send({ error: 'Beacon error', details: await response.text() });
        }
        return response.json();
      } catch (err) {
        return reply.code(503).send({
          error: 'Beacon unavailable',
          code: 'BEACON_UNAVAILABLE',
          details: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  );

  // ── Terminate a spawned agent ─────────────────────────────────────

  app.delete<{ Params: { beaconId: string; spawnId: string } }>(
    '/spawn/:beaconId/:spawnId',
    async (request, reply) => {
      const beacon = db.getBeacon(request.params.beaconId);
      if (!beacon) {
        return reply
          .code(404)
          .send({ error: 'Beacon not found', code: 'BEACON_NOT_FOUND' });
      }

      try {
        const response = await fetch(
          buildBeaconUrl(beacon, `/spawn/${request.params.spawnId}`),
          { method: 'DELETE' }
        );
        if (!response.ok) {
          return reply
            .code(502)
            .send({ error: 'Beacon error', details: await response.text() });
        }
        return response.json();
      } catch (err) {
        return reply.code(503).send({
          error: 'Beacon unavailable',
          code: 'BEACON_UNAVAILABLE',
          details: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  );
}

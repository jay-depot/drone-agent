import type { FastifyInstance } from 'fastify';
import * as db from '../db/index.js';
import type { SpawnRequest } from '../types.js';
import { sendBeaconCommand, type CommandResponse } from '../beacon-ws.js';

function handleCommandError(
  reply: { code: (c: number) => { send: (b: unknown) => unknown } },
  err: unknown
) {
  return reply.code(503).send({
    error: 'Target beacon unavailable',
    details: err instanceof Error ? err.message : 'Unknown error',
    code: 'BEACON_UNAVAILABLE',
  });
}

function respond(
  reply: { code: (c: number) => { send: (b: unknown) => unknown } },
  res: CommandResponse
) {
  const status = res.status ?? (res.ok ? 200 : 502);
  return reply.code(status).send(
    res.ok
      ? res.body
      : {
          error: 'Beacon error',
          details:
            res.body && typeof res.body === 'object' && 'error' in res.body
              ? (res.body as { error: string }).error
              : 'Unknown beacon error',
        }
  );
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

    // Forward the spawn request to the beacon over the reverse channel
    try {
      const res = await sendBeaconCommand(targetBeaconId, 'spawn', {
        personaId,
        task,
        config,
        spawnId,
      });
      if (res.ok) {
        return reply.code(201).send({
          ...(res.body as Record<string, unknown>),
          targetBeaconId,
        });
      }
      return respond(reply, res);
    } catch (err) {
      return handleCommandError(reply, err);
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
      const res = await sendBeaconCommand(
        request.params.beaconId,
        'listSpawns',
        { status: request.query.status }
      );
      if (res.ok) {
        return reply.code(200).send(res.body);
      }
      return respond(reply, res);
    } catch (err) {
      return handleCommandError(reply, err);
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
        const res = await sendBeaconCommand(
          request.params.beaconId,
          'getSpawn',
          { spawnId: request.params.spawnId }
        );
        if (res.ok) {
          return reply.code(200).send(res.body);
        }
        return respond(reply, res);
      } catch (err) {
        return handleCommandError(reply, err);
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
        const res = await sendBeaconCommand(
          request.params.beaconId,
          'terminateSpawn',
          { spawnId: request.params.spawnId }
        );
        if (res.ok) {
          return reply.code(200).send(res.body);
        }
        return respond(reply, res);
      } catch (err) {
        return handleCommandError(reply, err);
      }
    }
  );
}

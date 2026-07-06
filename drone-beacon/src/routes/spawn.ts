import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SpawnRequest } from '../types.js';
import { getBeaconUrl } from './context.js';
import * as db from '../db.js';
import * as spawner from '../spawner.js';

export default function spawnRoutes(app: FastifyInstance) {
  // Spawn a new agent
  app.post<{ Body: SpawnRequest }>('/spawn', async (request, reply) => {
    const { personaId, task, config, spawnId } = request.body;

    // Validate persona exists if provided
    if (personaId) {
      const persona = db.getPersona(personaId);
      if (!persona) {
        return reply
          .code(400)
          .send({ error: `Persona not found: ${personaId}` });
      }
    }

    // Generate IDs
    const finalSpawnId = spawnId || randomUUID();
    const agentId = `agent-${randomUUID()}`;

    try {
      const spawnRecord = await spawner.spawnAgent(
        finalSpawnId,
        agentId,
        personaId ?? null,
        task ?? null,
        config
      );

      return reply.code(202).send({
        spawnId: spawnRecord.id,
        agentId: agentId,
        status: spawnRecord.status,
        beaconUrl: getBeaconUrl(),
        message: 'Agent spawned, waiting for connection',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      // Create a failed spawn record
      const spawnRecord = db.createSpawn(
        finalSpawnId,
        personaId ?? null,
        task ?? null,
        config ?? null
      );
      db.updateSpawnStatus(finalSpawnId, 'failed', null, message);
      return reply.code(202).send({
        spawnId: finalSpawnId,
        agentId: agentId,
        status: 'failed',
        beaconUrl: getBeaconUrl(),
        message,
      });
    }
  });

  // List spawns (with optional status filter)
  app.get<{ Querystring: { status?: string } }>(
    '/spawn',
    async (request, _reply) => {
      const status = request.query.status;
      return db.listSpawns(status);
    }
  );

  // Get spawn status
  app.get<{ Params: { spawnId: string } }>(
    '/spawn/:spawnId',
    async (request, reply) => {
      const spawn = db.getSpawn(request.params.spawnId);
      if (!spawn) {
        return reply.code(404).send({ error: 'Spawn not found' });
      }
      return {
        spawnId: spawn.id,
        agentId: spawn.agentId,
        status: spawn.status,
        createdAt: spawn.createdAt,
        startedAt: spawn.startedAt,
        terminatedAt: spawn.terminatedAt,
        exitCode: spawn.exitCode,
        error: spawn.error,
      };
    }
  );

  // Terminate a spawned agent
  app.delete<{ Params: { spawnId: string } }>(
    '/spawn/:spawnId',
    async (request, reply) => {
      const spawn = db.getSpawn(request.params.spawnId);
      if (!spawn) {
        return reply.code(404).send({ error: 'Spawn not found' });
      }

      // Check if agent is still running
      if (spawn.status !== 'running' && spawn.status !== 'spawning') {
        return reply
          .code(400)
          .send({ error: `Cannot terminate: agent status is ${spawn.status}` });
      }

      // Try to terminate the process
      const terminated = spawner.terminateAgent(request.params.spawnId, false);
      if (!terminated) {
        return reply
          .code(400)
          .send({ error: 'Failed to terminate agent process' });
      }

      return { success: true, message: 'Termination signal sent' };
    }
  );
}

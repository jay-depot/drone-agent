import type { FastifyInstance } from 'fastify';
import * as db from '../db/index.js';
import { overlayEntries } from '../secret-overlay.js';

export default function configRoutes(app: FastifyInstance) {
  // Get the merged beacon config: beacon-local wins over coordinator-pushed
  // swarm entries, one row per key (the agent injector loops this directly).
  // Secret-bearing rows (memory-only overlay, never persisted) contribute
  // only their resolved values for keys not already present — beacon-local
  // and persisted coordinator rows keep precedence.
  app.get('/config', async () => {
    const merged = db.listMergedConfig();
    const byKey = new Map(merged.map(e => [e.key, e]));
    for (const overlay of overlayEntries()) {
      if (!byKey.has(overlay.key)) {
        byKey.set(overlay.key, {
          key: overlay.key,
          value: overlay.value,
          scope: 'swarm',
          createdAt: overlay.updatedAt,
          updatedAt: overlay.updatedAt,
        });
      }
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  });

  // Get specific config value
  app.get<{ Params: { key: string } }>(
    '/config/:key',
    async (request, reply) => {
      const config = db.getBeaconConfig(request.params.key);
      if (!config) {
        return reply.code(404).send({ error: 'Config not found' });
      }
      return config;
    }
  );

  // Set a config override
  app.post<{ Body: db.CreateConfigRequest }>(
    '/config',
    async (request, reply) => {
      const config = db.createBeaconConfig(request.body);
      return reply.code(201).send(config);
    }
  );

  // Update config override
  app.put<{ Params: { key: string }; Body: { value: string } }>(
    '/config/:key',
    async (request, reply) => {
      const config = db.updateBeaconConfig(
        request.params.key,
        request.body.value
      );
      if (!config) {
        return reply.code(404).send({ error: 'Config not found' });
      }
      return config;
    }
  );

  // Remove config override
  app.delete<{ Params: { key: string } }>(
    '/config/:key',
    async (request, reply) => {
      const deleted = db.deleteBeaconConfig(request.params.key);
      if (!deleted) {
        return reply.code(404).send({ error: 'Config not found' });
      }
      return { success: true };
    }
  );
}

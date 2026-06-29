import type { FastifyInstance } from 'fastify';
import * as db from '../db.js';

export default function configRoutes(app: FastifyInstance) {
  // Get all beacon config overrides
  app.get('/config', async () => {
    return db.listBeaconConfig();
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

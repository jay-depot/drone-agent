import type { FastifyInstance } from 'fastify';
import { isUnderlayAllowed, UNDERLAY_ALLOWLIST } from 'drone-core';
import * as db from '../db/index.js';
import { maskSecretValue } from '../mask.js';

export default function configRoutes(app: FastifyInstance) {
  // List all config entries. Secret values are masked on read.
  app.get('/config', async () => {
    const entries = db.listCoordinatorConfig();
    return entries.map(entry => ({
      key: entry.key,
      value: entry.secret ? maskSecretValue(entry.value) : entry.value,
      secret: entry.secret,
      description: entry.description ?? null,
      updatedAt: entry.updatedAt,
    }));
  });

  // Get a single config entry (masked if secret).
  app.get<{ Params: { key: string } }>(
    '/config/:key',
    async (request, reply) => {
      const entry = db.getCoordinatorConfig(request.params.key);
      if (!entry) {
        return reply.code(404).send({ error: 'Config key not found' });
      }
      return {
        key: entry.key,
        value: entry.secret ? maskSecretValue(entry.value) : entry.value,
        secret: entry.secret,
        description: entry.description ?? null,
        updatedAt: entry.updatedAt,
      };
    }
  );

  // Create or update a config entry. The key must match the underlay allowlist.
  app.put<{
    Params: { key: string };
    Body: { value: string; secret?: boolean; description?: string | null };
  }>('/config/:key', async (request, reply) => {
    const key = request.params.key;
    if (!isUnderlayAllowed(key)) {
      return reply.code(400).send({
        error: `Config key "${key}" is not distributable. Valid patterns: ${UNDERLAY_ALLOWLIST.join(', ')}`,
      });
    }
    const { value, secret, description } = request.body ?? {};
    if (typeof value !== 'string') {
      return reply.code(400).send({ error: 'value must be a JSON string' });
    }
    const entry = db.upsertCoordinatorConfig({
      key,
      value,
      secret: secret ?? false,
      description: description ?? null,
    });
    return {
      key: entry.key,
      value: entry.secret ? maskSecretValue(entry.value) : entry.value,
      secret: entry.secret,
      description: entry.description ?? null,
      updatedAt: entry.updatedAt,
    };
  });

  // Delete a config entry.
  app.delete<{ Params: { key: string } }>(
    '/config/:key',
    async (request, reply) => {
      const deleted = db.deleteCoordinatorConfig(request.params.key);
      if (!deleted) {
        return reply.code(404).send({ error: 'Config key not found' });
      }
      return { success: true };
    }
  );
}

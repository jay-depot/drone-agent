import type { FastifyInstance } from 'fastify';
import { extractSecretRefs } from 'drone-core';
import * as db from '../db/index.js';
import { notifyConfigChanged } from '../beacon-ws.js';

const SECRET_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

export default function secretRoutes(app: FastifyInstance) {
  // List stored secrets (masked values) plus which config settings reference
  // each name — powers the list, per-row referenced-by counts, and the delete
  // soft-confirm in one call.
  app.get('/secrets', async () => {
    const secrets = db.listSecrets();
    const configEntries = db.listCoordinatorConfig();
    const refCounts = new Map<string, string[]>();
    for (const entry of configEntries) {
      for (const name of extractSecretRefs(entry.value)) {
        const existing = refCounts.get(name) ?? [];
        existing.push(entry.key);
        refCounts.set(name, existing);
      }
    }
    return secrets.map(s => ({
      name: s.name,
      maskedValue: s.maskedValue,
      updatedAt: s.updatedAt,
      referencedBy: refCounts.get(s.name) ?? [],
    }));
  });

  // Add a secret or rotate an existing one. Creating requires a non-empty
  // value; rotating with an omitted/empty value keeps the current one.
  app.put<{
    Params: { name: string };
    Body: { value?: string };
  }>('/secrets/:name', async (request, reply) => {
    const name = request.params.name;
    if (!SECRET_NAME_PATTERN.test(name)) {
      return reply.code(400).send({
        error:
          'Secret names may contain only letters, digits, and underscores ([A-Za-z0-9_]+).',
      });
    }
    const value = request.body?.value?.trim() ?? '';
    const existing = db.getSecretValue(name);
    if (value === '' && existing === undefined) {
      return reply
        .code(400)
        .send({ error: 'A value is required to create a new stored secret.' });
    }
    const entry = db.upsertSecret({ name, value: value || existing! });
    notifyConfigChanged();
    return {
      name: entry.name,
      maskedValue: entry.maskedValue,
      updatedAt: entry.updatedAt,
    };
  });

  app.delete<{ Params: { name: string } }>(
    '/secrets/:name',
    async (request, reply) => {
      const name = request.params.name;
      const deleted = db.deleteSecret(name);
      if (!deleted) {
        return reply.code(404).send({ error: 'Stored secret not found' });
      }
      notifyConfigChanged();
      return { success: true };
    }
  );
}

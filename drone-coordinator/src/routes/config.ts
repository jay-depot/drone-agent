import type { FastifyInstance } from 'fastify';
import {
  extractSecretRefs,
  isUnderlayAllowed,
  UNDERLAY_ALLOWLIST,
} from 'drone-core';
import * as db from '../db/index.js';
import { maskSecretValue } from '../mask.js';
import { buildDistributionEntries } from '../config-resolve.js';
import { notifyConfigChanged } from '../beacon-ws.js';
import { logger } from '../logger.js';

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

  /**
   * Beacon-facing distribution payload: every `${secret:NAME}` reference has
   * been substituted with the real stored value, and each entry carries a
   * `containsSecrets` flag. RESOLVED SECRET VALUES MUST NEVER BE SURFACED via
   * the UI-facing `/config` GETs above — resolve only here, on the payload
   * the beacon consumes. Dangling references drop the row (per design): a
   * row stays out of distribution until its references resolve or it is
   * removed.
   */
  app.get('/config/distribution', async () => {
    const { entries, dropped } = buildDistributionEntries(
      db.listCoordinatorConfig(),
      db.getSecretValue
    );
    for (const drop of dropped) {
      logger.warn(
        `Dropping config entry "${drop.key}" from distribution: unknown secret reference(s) ${drop.missing.join(', ')}`
      );
    }
    return { entries };
  });

  // Create or update a config entry. The key must match the underlay allowlist.
  app.put<{
    Params: { key: string };
    Body: { value?: string; secret?: boolean; description?: string | null };
  }>('/config/:key', async (request, reply) => {
    const key = request.params.key;
    if (!isUnderlayAllowed(key)) {
      return reply.code(400).send({
        error: `Config key "${key}" is not distributable. Valid patterns: ${UNDERLAY_ALLOWLIST.join(', ')}`,
      });
    }
    const { value, secret, description } = request.body ?? {};
    const existing = db.getCoordinatorConfig(key);

    // Reject references to stored secrets that do not (yet) exist.
    if (typeof value === 'string' && value !== '') {
      const unknown = extractSecretRefs(value).filter(
        name => !db.getSecretValue(name)
      );
      if (unknown.length > 0) {
        return reply.code(400).send({
          error: `Unknown stored secret reference(s): ${unknown.join(', ')}. Create the secret in the Stored Secrets manager first.`,
        });
      }
    }

    // Secrets are write-only: an omitted or empty value on an existing
    // secret entry means "keep the current stored value".
    let effectiveValue = value;
    if (
      typeof effectiveValue !== 'string' ||
      effectiveValue.trim() === ''
    ) {
      if (existing?.secret === true) {
        effectiveValue = existing.value;
      } else {
        return reply
          .code(400)
          .send({ error: 'value must be a JSON string' });
      }
    }

    const entry = db.upsertCoordinatorConfig({
      key,
      value: effectiveValue,
      secret: secret ?? existing?.secret ?? false,
      description: description ?? existing?.description ?? null,
    });
    notifyConfigChanged();
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
      notifyConfigChanged();
      return { success: true };
    }
  );
}

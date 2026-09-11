import type { FastifyInstance } from 'fastify';
import { isUnderlayAllowed, UNDERLAY_ALLOWLIST } from 'drone-core';
import * as db from '../db/index.js';

/**
 * Mask a secret config value for read endpoints: `••••` + last 4 chars of the
 * raw value. Nested JSON provider entries get their `apiKey` field masked too;
 * scalar values are masked directly. `${VAR}` templates are preserved verbatim
 * (receiver-side interpolation) so a masked display never leaks the literal.
 */
export function maskSecretValue(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (
          (k === 'apiKey' || k === 'api_key' || k.endsWith('Key')) &&
          typeof v === 'string'
        ) {
          copy[k] = maskScalar(v);
        } else {
          copy[k] = v;
        }
      }
      return JSON.stringify(copy);
    }
  } catch {
    // Not JSON — fall through to scalar masking.
  }
  return maskScalar(value);
}

function maskScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 4) {
    return '••••';
  }
  return `••••${trimmed.slice(-4)}`;
}

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
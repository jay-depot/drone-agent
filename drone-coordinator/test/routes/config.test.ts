import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import type { FastifyInstance } from 'fastify';
import { maskSecretValue } from '../../src/mask.js';
import {
  upsertCoordinatorConfig,
  getCoordinatorConfig,
  listCoordinatorConfig,
  deleteCoordinatorConfig,
  upsertSecret,
} from '../../src/db/index.js';

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

describe('CoordinatorConfig DB', () => {
  it('upserts a config entry and reads it back', () => {
    const entry = upsertCoordinatorConfig({
      key: 'llm.active',
      value: JSON.stringify('openai/gpt-5.3-codex'),
      secret: false,
    });
    expect(entry.key).toBe('llm.active');
    expect(entry.secret).toBe(false);

    const fetched = getCoordinatorConfig('llm.active');
    expect(fetched).toBeDefined();
    expect(fetched!.value).toBe('"openai/gpt-5.3-codex"');
  });

  it('upsert preserves createdAt and updates updatedAt', async () => {
    const first = upsertCoordinatorConfig({
      key: 'compaction.enabled',
      value: 'true',
    });
    await new Promise(r => setTimeout(r, 5));
    const second = upsertCoordinatorConfig({
      key: 'compaction.enabled',
      value: 'false',
      description: 'tuned down',
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(second.description).toBe('tuned down');
  });

  it('lists all config entries ordered by key', () => {
    upsertCoordinatorConfig({ key: 'llm.active', value: '"a"' });
    upsertCoordinatorConfig({ key: 'compaction.enabled', value: 'true' });
    const list = listCoordinatorConfig();
    expect(list.map(e => e.key)).toEqual(['compaction.enabled', 'llm.active']);
  });

  it('deletes a config entry', () => {
    upsertCoordinatorConfig({ key: 'llm.active', value: '"a"' });
    expect(deleteCoordinatorConfig('llm.active')).toBe(true);
    expect(getCoordinatorConfig('llm.active')).toBeUndefined();
    expect(deleteCoordinatorConfig('llm.active')).toBe(false);
  });

  it('defaults secret to false', () => {
    upsertCoordinatorConfig({ key: 'llm.reasoningLevel', value: '"high"' });
    expect(getCoordinatorConfig('llm.reasoningLevel')!.secret).toBe(false);
  });
});

describe('CoordinatorConfig Routes', () => {
  it('GET /api/config lists entries with secret values masked', async () => {
    upsertCoordinatorConfig({
      key: 'providers.openai',
      value: JSON.stringify({ apiKey: 'sk-secret-1234' }),
      secret: true,
    });
    upsertCoordinatorConfig({
      key: 'llm.active',
      value: JSON.stringify('openai/gpt-5.3-codex'),
    });

    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      key: string;
      value: string;
      secret: boolean;
    }>;
    expect(body.length).toBe(2);
    const provider = body.find(e => e.key === 'providers.openai')!;
    expect(provider.secret).toBe(true);
    // apiKey is masked, last 4 preserved.
    expect(provider.value).toContain('••••1234');
    expect(provider.value).not.toContain('sk-secret-1234');
    const active = body.find(e => e.key === 'llm.active')!;
    expect(active.secret).toBe(false);
    expect(active.value).toBe('"openai/gpt-5.3-codex"');
  });

  it('GET /api/config/:key returns a single masked entry', async () => {
    upsertCoordinatorConfig({
      key: 'providers.openai',
      value: JSON.stringify({ apiKey: 'sk-secret-xyz' }),
      secret: true,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/config/providers.openai',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { value: string };
    // Masked: `••••` + last 4 chars of the apiKey (`-xyz`).
    expect(body.value).toContain('••••-xyz');
    expect(body.value).not.toContain('sk-secret-xyz');
  });

  it('GET /api/config/:key returns 404 for missing key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config/nonexistent.key',
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/config/:key accepts an allowlisted key and upserts', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/providers.anthropic',
      payload: {
        value: JSON.stringify({ apiKey: 'sk-ant-test' }),
        secret: true,
        description: 'Anthropic provider',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      key: string;
      secret: boolean;
      value: string;
    };
    expect(body.key).toBe('providers.anthropic');
    expect(body.secret).toBe(true);
    expect(body.value).toContain('••••test');
    expect(body.value).not.toContain('sk-ant-test');

    const stored = getCoordinatorConfig('providers.anthropic')!;
    expect(stored.value).toBe(JSON.stringify({ apiKey: 'sk-ant-test' }));
  });

  it('PUT /api/config/:key rejects a non-allowlisted key with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/system.prompt',
      payload: { value: JSON.stringify('hacked') },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain('not distributable');
    expect(body.error).toContain('providers.*');
  });

  it('PUT /api/config/:key requires a string value', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/llm.active',
      payload: { value: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('JSON string');
  });

  it('DELETE /api/config/:key deletes an entry', async () => {
    upsertCoordinatorConfig({ key: 'llm.active', value: '"a"' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/config/llm.active',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(getCoordinatorConfig('llm.active')).toBeUndefined();
  });

  it('DELETE /api/config/:key returns 404 for missing key', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/config/llm.active',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('maskSecretValue', () => {
  it('preserves ${VAR} templates verbatim (scalar)', () => {
    expect(maskSecretValue('${OPENROUTER_API_KEY}')).toBe(
      '${OPENROUTER_API_KEY}'
    );
  });

  it('preserves ${VAR} templates inside provider JSON apiKey fields', () => {
    const value = JSON.stringify({
      protocol: 'openrouter',
      apiKey: '${OPENROUTER_API_KEY}',
    });
    expect(maskSecretValue(value)).toBe(value);
  });

  it('masks plain scalar secrets to bullets + last 4', () => {
    expect(maskSecretValue('sk-plain-secret-1234')).toBe('••••1234');
  });

  it('masks short scalars fully', () => {
    expect(maskSecretValue('abc')).toBe('••••');
  });

  it('masks nested provider apiKey fields', () => {
    expect(maskSecretValue(JSON.stringify({ apiKey: 'sk-secret-5678' }))).toBe(
      JSON.stringify({ apiKey: '••••5678' })
    );
  });

  it('masks strings that only embed a template mid-string', () => {
    expect(maskSecretValue('prefix ${VAR}')).toBe('••••VAR}');
  });
});

describe('Config secret-reference validation + distribution', () => {
  it('PUT rejects a reference to an unknown stored secret with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/providers.openai',
      payload: { value: JSON.stringify({ apiKey: '${secret:MISSING}' }) },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('MISSING');
    expect(getCoordinatorConfig('providers.openai')).toBeUndefined();
  });

  it('PUT accepts a reference to a known stored secret', async () => {
    upsertSecret({ name: 'KNOWN', value: 'sk-known-1234' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/providers.openai',
      payload: { value: JSON.stringify({ apiKey: '${secret:KNOWN}' }) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PUT with an omitted/empty value keeps the current stored secret', async () => {
    upsertCoordinatorConfig({
      key: 'providers.openai',
      value: '{"apiKey":"sk-current-9999"}',
      secret: true,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/providers.openai',
      payload: { description: 'new desc' },
    });
    expect(res.statusCode).toBe(200);
    const stored = getCoordinatorConfig('providers.openai')!;
    expect(stored.value).toBe('{"apiKey":"sk-current-9999"}');
    expect(stored.description).toBe('new desc');
  });

  it('GET /config/distribution resolves refs and flags containsSecrets', async () => {
    upsertSecret({ name: 'KNOWN', value: 'sk-real-1234' });
    upsertCoordinatorConfig({
      key: 'providers.openai',
      value: JSON.stringify({ apiKey: '${secret:KNOWN}' }),
    });
    upsertCoordinatorConfig({ key: 'llm.active', value: '"openai/main"' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/config/distribution',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      entries: Array<{ key: string; value: string; containsSecrets: boolean }>;
    };
    const provider = body.entries.find(e => e.key === 'providers.openai')!;
    expect(provider.value).toContain('sk-real-1234');
    expect(provider.containsSecrets).toBe(true);
    const active = body.entries.find(e => e.key === 'llm.active')!;
    expect(active.containsSecrets).toBe(false);
  });

  it('GET /config/distribution drops rows with dangling references', async () => {
    upsertCoordinatorConfig({
      key: 'providers.broken',
      value: '{"apiKey":"${secret:GONE}"}',
    });
    upsertCoordinatorConfig({ key: 'llm.active', value: '"x"' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/config/distribution',
    });
    const body = JSON.parse(res.body) as { entries: Array<{ key: string }> };
    expect(body.entries.find(e => e.key === 'providers.broken')).toBeUndefined();
    expect(body.entries.find(e => e.key === 'llm.active')).toBeDefined();
  });
});

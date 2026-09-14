import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import type { FastifyInstance } from 'fastify';
import {
  upsertSecret,
  getSecretValue,
  upsertCoordinatorConfig,
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

describe('Stored Secrets Routes', () => {
  it('GET /secrets lists masked values and referencedBy', async () => {
    upsertSecret({ name: 'API_KEY', value: 'sk-real-4321' });
    upsertCoordinatorConfig({
      key: 'providers.openai',
      value: JSON.stringify({ apiKey: '${secret:API_KEY}' }),
    });

    const res = await app.inject({ method: 'GET', url: '/api/secrets' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      name: string;
      maskedValue: string;
      referencedBy: string[];
    }>;
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('API_KEY');
    expect(body[0].maskedValue).toBe('••••4321');
    expect(body[0].referencedBy).toEqual(['providers.openai']);
    expect(JSON.stringify(body)).not.toContain('sk-real-4321');
  });

  it('PUT /secrets/:name creates a secret', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/secrets/NEW_KEY',
      payload: { value: 'sk-new-value' },
    });
    expect(res.statusCode).toBe(200);
    expect(getSecretValue('NEW_KEY')).toBe('sk-new-value');
  });

  it('PUT /secrets/:name rejects an invalid name charset', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/secrets/bad.name',
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(getSecretValue('bad.name')).toBeUndefined();
  });

  it('PUT /secrets/:name requires a value to create new', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/secrets/NEW_KEY',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(getSecretValue('NEW_KEY')).toBeUndefined();
  });

  it('PUT /secrets/:name with empty/omitted value keeps the current secret', async () => {
    upsertSecret({ name: 'ROT', value: 'sk-original-1111' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/secrets/ROT',
      payload: { value: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(getSecretValue('ROT')).toBe('sk-original-1111');
  });

  it('PUT /secrets/:name rotates the value', async () => {
    upsertSecret({ name: 'ROT', value: 'sk-old-1111' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/secrets/ROT',
      payload: { value: 'sk-new-9999' },
    });
    expect(res.statusCode).toBe(200);
    expect(getSecretValue('ROT')).toBe('sk-new-9999');
  });

  it('DELETE /secrets/:name deletes a secret', async () => {
    upsertSecret({ name: 'GONE', value: 'sk-x' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/secrets/GONE',
    });
    expect(res.statusCode).toBe(200);
    expect(getSecretValue('GONE')).toBeUndefined();
  });

  it('DELETE /secrets/:name returns 404 for missing secret', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/secrets/NOPE',
    });
    expect(res.statusCode).toBe(404);
  });
});

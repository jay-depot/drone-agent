import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

describe('Persona Routes', () => {
  const validPersona = {
    id: 'test-persona',
    name: 'Test Persona',
    description: 'A test persona',
    systemPrompt: 'You are a test persona.',
  };

  it('POST /personas creates a persona', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('test-persona');
    expect(body.scope).toBe('coordinator');
  });

  it('GET /personas lists personas', async () => {
    await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/personas',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
  });

  it('GET /personas/:id returns a persona', async () => {
    await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/personas/test-persona',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('test-persona');
  });

  it('GET /personas/:id returns 404 for missing persona', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/personas/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /personas/:id updates a persona', async () => {
    await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/personas/test-persona',
      payload: { name: 'Updated' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('Updated');
  });

  it('PUT /personas/:id returns 404 for missing persona', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/personas/nonexistent',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /personas/:id deletes a persona', async () => {
    await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/personas/test-persona',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /personas/:id returns 404 for missing persona', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/personas/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

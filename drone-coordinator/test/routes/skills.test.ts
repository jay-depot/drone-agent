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

describe('Skill Routes', () => {
  const validSkill = {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    trigger: 'test-trigger',
    body: '# Skill Body',
  };

  it('POST /skills creates a skill', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: validSkill,
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).id).toBe('test-skill');
  });

  it('GET /skills lists skills', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: validSkill,
    });
    const res = await app.inject({ method: 'GET', url: '/api/skills' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /skills/:id returns a skill', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: validSkill,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/skills/test-skill',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('test-skill');
  });

  it('GET /skills/:id returns 404 for missing skill', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/skills/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /skills/:id updates a skill', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: validSkill,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/skills/test-skill',
      payload: { name: 'Updated' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('Updated');
  });

  it('PUT /skills/:id returns 404 for missing skill', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/skills/nonexistent',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /skills/:id deletes a skill', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: validSkill,
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/skills/test-skill',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /skills/:id returns 404 for missing skill', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/skills/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

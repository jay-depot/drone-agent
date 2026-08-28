import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import { setCoordinatorFingerprint } from '../../src/routes/health.js';
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

describe('GET /health', () => {
  it('returns status ok with timestamp', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('number');
  });

  it('returns the TLS fingerprint when set', async () => {
    setCoordinatorFingerprint(
      'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'
    );
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tlsFingerprint).toBe(
      'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'
    );
  });

  it('omits the TLS fingerprint when not set', async () => {
    setCoordinatorFingerprint(undefined);
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    const body = JSON.parse(res.body);
    expect(body.tlsFingerprint).toBeUndefined();
  });
});

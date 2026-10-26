import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
import { registerBeaconTrust, closeDatabase } from '../src/db/index.js';
import { resolveRateLimitKey } from '../src/rate-limit.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp({ rateLimitMax: 3, rateLimitWindowMs: 60000 });
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

function makeKeyReq(
  opts: { ip?: string; nodeId?: string } = {}
): FastifyRequest {
  return {
    url: '/health',
    method: 'GET',
    ip: opts.ip,
    headers: opts.nodeId ? { 'x-node-id': opts.nodeId } : {},
    socket: { getPeerCertificate: () => false },
  } as unknown as FastifyRequest;
}

describe('resolveRateLimitKey', () => {
  it('uses the raw IP when no node id resolves', () => {
    expect(resolveRateLimitKey(makeKeyReq({ ip: '10.0.0.1' }))).toBe(
      '10.0.0.1'
    );
  });

  it('falls back to "unknown" when req.ip is undefined', () => {
    expect(resolveRateLimitKey(makeKeyReq({}))).toBe('unknown');
  });

  it('de-maps an IPv4-in-IPv6 address', () => {
    expect(resolveRateLimitKey(makeKeyReq({ ip: '::ffff:10.0.0.1' }))).toBe(
      '10.0.0.1'
    );
  });

  it('collapses a bare IPv6 address to its /64 prefix', () => {
    expect(resolveRateLimitKey(makeKeyReq({ ip: '2001:db8::1' }))).toBe(
      '2001:db8::'
    );
    expect(resolveRateLimitKey(makeKeyReq({ ip: '2001:db8::2' }))).toBe(
      '2001:db8::'
    );
  });

  it('never throws when node-id resolution fails, falling back to the IP', () => {
    closeDatabase();
    expect(
      resolveRateLimitKey(makeKeyReq({ ip: '10.0.0.1', nodeId: 'ghost' }))
    ).toBe('10.0.0.1');
  });
});

describe('Rate limiting', () => {
  it('allows requests under the limit', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('returns 429 once the limit is exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'GET', url: '/health' });
    }
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(429);
  });

  it('keeps a separate bucket per client IP', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '10.0.0.1',
      });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '10.0.0.2',
    });
    expect(res.statusCode).toBe(200);
  });

  it('keys the fallback bucket by client IP for an unregistered node id', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-node-id': 'ghost' },
        remoteAddress: '10.0.0.1',
      });
      expect(res.statusCode).toBe(200);
    }
    const sameAddress = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-node-id': 'other-ghost' },
      remoteAddress: '10.0.0.1',
    });
    expect(sameAddress.statusCode).toBe(429);
    const otherAddress = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-node-id': 'ghost' },
      remoteAddress: '10.0.0.2',
    });
    expect(otherAddress.statusCode).toBe(200);
  });

  it('shares one fallback bucket across the IPv4-mapped and plain forms', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-node-id': 'ghost' },
        remoteAddress: '::ffff:10.0.0.1',
      });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-node-id': 'ghost' },
      remoteAddress: '10.0.0.1',
    });
    expect(res.statusCode).toBe(429);
  });

  it('keys the bucket by node id across client addresses', async () => {
    registerBeaconTrust(
      {
        id: 'b-rl',
        name: 'Rate Limit Beacon',
        host: '10.0.0.1',
        port: 3457,
        publicKey: 'key-rl',
      },
      { socketIsLocal: true }
    );
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-node-id': 'b-rl' },
        remoteAddress: '10.0.0.1',
      });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-node-id': 'b-rl' },
      remoteAddress: '10.0.0.2',
    });
    expect(res.statusCode).toBe(429);
  });
});

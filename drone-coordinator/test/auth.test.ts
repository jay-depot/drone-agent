import { describe, expect, it } from 'vitest';
import { createWebAuthMiddleware, isLocalRequest } from '../src/web-auth.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

// ── isLocalRequest ──────────────────────────────────────────────────

describe('isLocalRequest', () => {
  function makeReq(ip: string) {
    return { ip } as unknown as FastifyRequest;
  }

  it('returns true for 127.0.0.1', () => {
    expect(isLocalRequest(makeReq('127.0.0.1'))).toBe(true);
  });

  it('returns true for ::1', () => {
    expect(isLocalRequest(makeReq('::1'))).toBe(true);
  });

  it('returns true for IPv4-mapped IPv6 localhost', () => {
    expect(isLocalRequest(makeReq('::ffff:127.0.0.1'))).toBe(true);
  });

  it('returns false for public IP', () => {
    expect(isLocalRequest(makeReq('8.8.8.8'))).toBe(false);
  });

  it('returns false for another public IP', () => {
    expect(isLocalRequest(makeReq('203.0.113.1'))).toBe(false);
  });
});

// ── createWebAuthMiddleware ─────────────────────────────────────────

describe('createWebAuthMiddleware', () => {
  function makeReq(ip: string, url: string, authHeader?: string) {
    return {
      ip,
      url,
      headers: {
        authorization: authHeader,
      },
    } as unknown as FastifyRequest;
  }

  function makeReply(): FastifyReply & { _code(): number } {
    let code = 0;
    return {
      code: (c: number) => {
        code = c;
        return {
          send: () => {},
        };
      },
      _code: () => code,
    } as unknown as FastifyReply & { _code(): number };
  }

  it('allows local requests without token', async () => {
    const middleware = createWebAuthMiddleware(() => 'secret');
    const reply = makeReply();
    await middleware(makeReq('127.0.0.1', '/personas'), reply);
    // No reply sent means it passed through
    expect(reply._code()).toBe(0);
  });

  it('blocks non-local requests without auth header', async () => {
    const middleware = createWebAuthMiddleware(() => 'secret');
    const reply = makeReply();
    await middleware(makeReq('8.8.8.8', '/personas'), reply);
    expect(reply._code()).toBe(401);
  });

  it('allows non-local requests with correct auth header', async () => {
    const middleware = createWebAuthMiddleware(() => 'secret');
    const reply = makeReply();
    await middleware(makeReq('8.8.8.8', '/personas', 'Bearer secret'), reply);
    // No reply sent means it passed through
    expect(reply._code()).toBe(0);
  });

  it('blocks non-local requests with wrong auth header', async () => {
    const middleware = createWebAuthMiddleware(() => 'secret');
    const reply = makeReply();
    await middleware(makeReq('8.8.8.8', '/personas', 'Bearer wrong'), reply);
    expect(reply._code()).toBe(401);
  });

  it('allows requests to unprotected paths', async () => {
    const middleware = createWebAuthMiddleware(() => 'secret');
    const reply = makeReply();
    await middleware(makeReq('8.8.8.8', '/'), reply);
    expect(reply._code()).toBe(0);
  });

  it('allows non-local requests when no token is configured', async () => {
    const middleware = createWebAuthMiddleware(() => null);
    const reply = makeReply();
    await middleware(makeReq('8.8.8.8', '/personas'), reply);
    expect(reply._code()).toBe(0);
  });
});

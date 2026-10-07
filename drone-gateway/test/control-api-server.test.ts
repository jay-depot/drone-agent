import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ControlApiServer } from '../src/control-api/server.js';
import {
  UnknownAdapterError,
  UnknownConversationError,
  InjectionNotEnabledError,
} from '../src/errors.js';
import type { GatewayEngine } from '../src/engine.js';
import type { ControlApiConfig } from '../src/types.js';

const PORT = 18000 + (process.pid % 1000);

function makeServer(
  injectMessage: (a: string, c: string, t: string) => Promise<void>,
  token?: string
): ControlApiServer {
  const engine = {
    listAdapterIds: () => ['matrix'],
    listInjectableConversations: () => [
      { adapterId: 'matrix', conversationId: '!room:s' },
    ],
    injectMessage,
  } as unknown as GatewayEngine;
  const config: ControlApiConfig = token
    ? { enabled: true, host: '127.0.0.1', port: PORT, token }
    : { enabled: true, host: '127.0.0.1', port: PORT };
  return new ControlApiServer({ engine, config, version: '9.9.9' });
}

function base(server: ControlApiServer): string {
  void server;
  return `http://127.0.0.1:${PORT}`;
}

describe('ControlApiServer', () => {
  let server: ControlApiServer | undefined;

  beforeEach(() => {
    server = undefined;
  });

  afterEach(async () => {
    await server?.stop();
  });

  it('serves GET /status', async () => {
    server = makeServer(vi.fn());
    await server.start();
    const res = await fetch(`${base(server)}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: '9.9.9',
      adapters: ['matrix'],
    });
  });

  it('serves GET /conversations', async () => {
    server = makeServer(vi.fn());
    await server.start();
    const res = await fetch(`${base(server)}/conversations`);
    expect(await res.json()).toEqual({
      ok: true,
      conversations: [{ adapterId: 'matrix', conversationId: '!room:s' }],
    });
  });

  it('posts an injection on POST /inject', async () => {
    const inject = vi.fn().mockResolvedValue(undefined);
    server = makeServer(inject);
    await server.start();
    const res = await fetch(`${base(server)}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adapterId: 'matrix',
        conversationId: '!room:s',
        text: 'hi',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, posted: true });
    expect(inject).toHaveBeenCalledWith('matrix', '!room:s', 'hi');
  });

  it('returns 400 on a bad body', async () => {
    server = makeServer(vi.fn());
    await server.start();
    const res = await fetch(`${base(server)}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapterId: 'matrix' }),
    });
    expect(res.status).toBe(400);
  });

  it('maps UnknownAdapterError/UnknownConversationError to 404', async () => {
    server = makeServer(() => {
      throw new UnknownAdapterError('nope');
    });
    await server.start();
    const res = await fetch(`${base(server)}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adapterId: 'nope',
        conversationId: 'c',
        text: 'x',
      }),
    });
    expect(res.status).toBe(404);

    await server.stop();
    server = makeServer(() => {
      throw new UnknownConversationError('a', 'c');
    });
    await server.start();
    const res2 = await fetch(`${base(server)}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapterId: 'a', conversationId: 'c', text: 'x' }),
    });
    expect(res2.status).toBe(404);
  });

  it('maps InjectionNotEnabledError to 403', async () => {
    server = makeServer(() => {
      throw new InjectionNotEnabledError('a', 'c');
    });
    await server.start();
    const res = await fetch(`${base(server)}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapterId: 'a', conversationId: 'c', text: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('maps an unexpected error to 500', async () => {
    server = makeServer(() => {
      throw new Error('boom');
    });
    await server.start();
    const res = await fetch(`${base(server)}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapterId: 'a', conversationId: 'c', text: 'x' }),
    });
    expect(res.status).toBe(500);
  });

  describe('with a token configured', () => {
    it('rejects a request with no Authorization header', async () => {
      server = makeServer(vi.fn(), 'secret');
      await server.start();
      const res = await fetch(`${base(server)}/status`);
      expect(res.status).toBe(401);
    });

    it('rejects a wrong token', async () => {
      server = makeServer(vi.fn(), 'secret');
      await server.start();
      const res = await fetch(`${base(server)}/status`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      expect(res.status).toBe(401);
    });

    it('accepts the correct token', async () => {
      server = makeServer(vi.fn(), 'secret');
      await server.start();
      const res = await fetch(`${base(server)}/status`, {
        headers: { Authorization: 'Bearer secret' },
      });
      expect(res.status).toBe(200);
    });
  });
});

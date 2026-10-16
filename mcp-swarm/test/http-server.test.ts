import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMcpHttpServer, type McpHttpServer } from '../src/http-server.js';
import { SWARM_CAPABILITIES } from '../src/mapping.js';

const TOKEN = 'mcpsw_testtoken';

let server: McpHttpServer;
let baseUrl: string;
const invoke = vi.fn().mockResolvedValue({ ok: true, status: 200, body: 'ok' });

beforeEach(async () => {
  invoke.mockClear();
  invoke.mockResolvedValue({ ok: true, status: 200, body: 'ok' });
  server = await startMcpHttpServer({
    capabilities: SWARM_CAPABILITIES,
    invoke,
    verify: token => token === TOKEN,
    host: '127.0.0.1',
    port: 0,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
});

function post(body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('MCP streamable-HTTP transport', () => {
  it('answers initialize over POST with serverInfo', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(body.result.serverInfo.name).toBe('mcp-swarm');
  });

  it('lists only the mcp-tier tools', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map(t => t.name).sort()).toEqual([
      'swarm.agent.list',
      'swarm.session.list',
      'swarm.wiki.read',
    ]);
  });

  it('rejects a missing token with 401', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      null
    );
    expect(res.status).toBe(401);
  });

  it('rejects a bad token with 401 before parsing JSON', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong',
        'Content-Type': 'application/json',
      },
      body: 'not json at all',
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('answers GET /mcp with 405', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });

  it('answers DELETE /mcp with 204', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(204);
  });

  it('answers a notification with 202 and no body', async () => {
    const res = await post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('answers a non-/mcp path with 404', async () => {
    const res = await fetch(`${baseUrl}/nope`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('rejects a too-large body with 413', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) }),
    });
    expect(res.status).toBe(413);
  });

  it('routes a tools/call for an mcp-tier tool through the invoker', async () => {
    await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'swarm.wiki.read', arguments: { pageId: 'p' } },
    });
    expect(invoke).toHaveBeenCalledWith('swarm.wiki.read', { pageId: 'p' });
  });

  it('rejects a tools/call for a ui-tier tool', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'token.create', arguments: { name: 'x' } },
    });
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
    expect(invoke).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_MAPPINGS,
  SWARM_CAPABILITIES,
  executeCapability,
  isMcpExposed,
  isTokenCapability,
  mcpExposedCapabilities,
  mcpToolName,
} from '../src/mapping.js';
import { handleRequest, type McpRequestOptions } from '../src/mcp-server.js';
import { buildBundleFiles, BUNDLE, BUNDLE_INDEX_JS } from '../src/bundle.js';

describe('capability catalog', () => {
  it('declares the three read tools plus the four token capabilities', () => {
    const names = SWARM_CAPABILITIES.map(c => c.name).sort();
    expect(names).toEqual([
      'swarm.agent.list',
      'swarm.session.list',
      'swarm.wiki.read',
      'token.create',
      'token.list',
      'token.rename',
      'token.revoke',
    ]);
  });

  it('maps each capability 1:1 to an MCP tool name', () => {
    for (const cap of SWARM_CAPABILITIES) {
      expect(mcpToolName(cap.name)).toBe(cap.name);
    }
  });

  it('exposes only the read tools to MCP', () => {
    const exposed = mcpExposedCapabilities().map(c => c.name).sort();
    expect(exposed).toEqual([
      'swarm.agent.list',
      'swarm.session.list',
      'swarm.wiki.read',
    ]);
    expect(isMcpExposed('swarm.session.list')).toBe(true);
    expect(isMcpExposed('token.create')).toBe(false);
    expect(isTokenCapability('token.create')).toBe(true);
    expect(isTokenCapability('swarm.wiki.read')).toBe(false);
  });

  it('builds coordinator paths with query params', () => {
    const sessions = CAPABILITY_MAPPINGS.find(
      m => m.capability.name === 'swarm.session.list'
    );
    expect(sessions?.path({ status: 'active', exclude: '' })).toBe(
      '/api/sessions?status=active'
    );
    const wiki = CAPABILITY_MAPPINGS.find(
      m => m.capability.name === 'swarm.wiki.read'
    );
    expect(wiki?.path({ pageId: 'fragments-guide', scope: 'beacon' })).toBe(
      '/api/wiki/fragments-guide?scope=beacon'
    );
  });
});

describe('executeCapability', () => {
  it('executes against the coordinator with the mapped path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sessions: [], count: 0 }),
    });
    const result = await executeCapability(
      'swarm.session.list',
      { status: 'active' },
      fetchMock as unknown as typeof fetch,
      'https://coordinator:3456'
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://coordinator:3456/api/sessions?status=active',
      { method: 'GET' }
    );
  });

  it('returns a 404 for an unknown capability', async () => {
    const result = await executeCapability(
      'nope',
      {},
      vi.fn() as unknown as typeof fetch,
      'https://coordinator:3456'
    );
    expect(result.status).toBe(404);
  });

  it('surfaces a transport failure as ok:false status:0', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await executeCapability(
      'swarm.agent.list',
      {},
      fetchMock as unknown as typeof fetch,
      'https://coordinator:3456'
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });
});

describe('MCP request handling', () => {
  const opts: McpRequestOptions = {
    capabilities: SWARM_CAPABILITIES,
    invoke: vi.fn().mockResolvedValue({ ok: true, status: 200, body: 'ok' }),
  };

  it('answers initialize with the protocol version + tools capability', async () => {
    const res = await handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      opts
    );
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-swarm', version: '0.1.0' },
      },
    });
  });

  it('lists only the mcp-tier catalog as MCP tools', async () => {
    const res = (await handleRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      opts
    )) as { result: { tools: Array<{ name: string }> } };
    expect(res.result.tools.map(t => t.name).sort()).toEqual([
      'swarm.agent.list',
      'swarm.session.list',
      'swarm.wiki.read',
    ]);
  });

  it('routes tools/call through the invoker', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: { x: 1 } });
    const res = await handleRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'swarm.wiki.read', arguments: { pageId: 'p' } },
      },
      { ...opts, invoke }
    );
    expect(invoke).toHaveBeenCalledWith('swarm.wiki.read', { pageId: 'p' });
    expect(res).toMatchObject({ id: 3 });
  });

  it('rejects a tools/call for a ui-tier capability', async () => {
    const invoke = vi.fn();
    const res = (await handleRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'token.create', arguments: { name: 'x' } },
      },
      { ...opts, invoke }
    )) as { error: { code: number } };
    expect(res.error.code).toBe(-32602);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns an error result for a failing capability (not a throw)', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      status: 504,
      body: { error: 'timeout' },
    });
    const res = (await handleRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'swarm.session.list', arguments: {} },
      },
      { ...opts, invoke }
    )) as { result: { isError: boolean } };
    expect(res.result.isError).toBe(true);
  });

  it('rejects an unknown tool with a JSON-RPC error', async () => {
    const res = (await handleRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'missing', arguments: {} },
      },
      opts
    )) as { error: { code: number } };
    expect(res.error.code).toBe(-32602);
  });

  it('does not answer notifications', async () => {
    const res = await handleRequest(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      opts
    );
    expect(res).toBeNull();
  });
});

describe('front-end bundle', () => {
  it('registers the settings-panel and topology-page regions', () => {
    expect(BUNDLE_INDEX_JS).toContain("'settings-panel': SettingsPanel");
    expect(BUNDLE_INDEX_JS).toContain("'topology-page': StatusPanel");
  });

  it('references only token.* capabilities from the settings panel', () => {
    const calls = [...BUNDLE_INDEX_JS.matchAll(/callAction\('([^']+)'/g)].map(
      m => m[1]
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const name of calls) expect(name.startsWith('token.')).toBe(true);
  });

  it('emits an index.js + style.css with a bundle name', () => {
    const files = buildBundleFiles();
    expect(files.map(f => f.name)).toEqual(['index.js', 'style.css']);
    expect(files[0].contentType).toBe('application/javascript');
    expect(BUNDLE.name).toBe('status-panel');
  });
});

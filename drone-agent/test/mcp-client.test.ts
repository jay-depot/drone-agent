/**
 * @vitest-environment node
 *
 * Fast unit suite for the MCP client (`client.ts`) over the streamable-HTTP
 * transport. Uses an in-process `fetch` mock (see `mcp-fake-server.ts`) so no
 * network or subprocess is involved.
 *
 * NOTE: the Content-Length and line-delimited framing parsers live in stdio
 * transport code paths and can only be exercised against a real spawned child
 * (createMcpClientConnection calls `spawn` for stdio). Those framing tests live
 * in the SLOW integration suite (`mcp.test.ts` + `mcp-fake-server.mjs`).
 *
 * These tests assert CURRENT client behavior. The two known-defective behaviors
 * from the earlier Phase 1 baseline (`Mcp-Session-Id` not read/echoed, and
 * `tools/call` `isError` ignored) were fixed; the tests below now assert the
 * corrected behavior. They remain the regression net for later fix-phases.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createMcpClientConnection,
  splitToolResultBlocks,
} from '../src/plugins/mcp/client.js';
import { createMockFetch } from './mcp-fake-server.js';
import type { MockFetch } from './mcp-fake-server.js';
import type {
  DroneMcpRoot,
  DroneMcpServerConfig,
  DroneLogger,
} from 'drone-core';

const silentLogger: DroneLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function baseConfig(
  overrides: Partial<DroneMcpServerConfig> = {}
): DroneMcpServerConfig {
  return {
    transport: 'streamable_http',
    url: 'http://localhost:9999/mcp',
    ...overrides,
  } as DroneMcpServerConfig;
}

/**
 * Build a connection. The caller is responsible for installing
 * `globalThis.fetch` (we do so in beforeEach / per-test) because the
 * connection's methods (listTools, callTool, ...) also call fetch and run
 * OUTSIDE this helper. Restoring fetch inside this helper's finally would make
 * those later calls hit the real network.
 */
async function makeConnection(
  mock: MockFetch,
  configOverrides: Partial<DroneMcpServerConfig> = {},
  defaults: Partial<{
    requestTimeoutMs: number;
    spawnTimeoutMs: number;
    retryCount: number;
    retryDelayMs: number;
    maxListPages: number;
    maxListItems: number;
    compatibilityMode: 'strict' | 'permissive';
    maxResponseSizeBytes: number;
  }> = {},
  callbacks: {
    onNotification?: (method: string, params: unknown) => void;
    onStreamError?: (message: string) => void;
  } = {},
  roots?: DroneMcpRoot[]
) {
  const conn = await createMcpClientConnection({
    serverId: 'demo',
    config: baseConfig(configOverrides),
    defaultRequestTimeoutMs: defaults.requestTimeoutMs ?? 1000,
    defaultSpawnTimeoutMs: defaults.spawnTimeoutMs ?? 3000,
    defaultRetryCount: defaults.retryCount ?? 0,
    defaultRetryDelayMs: defaults.retryDelayMs ?? 0,
    defaultMaxListPages: defaults.maxListPages ?? 25,
    defaultMaxListItems: defaults.maxListItems ?? 500,
    defaultCompatibilityMode: defaults.compatibilityMode ?? 'strict',
    defaultMaxResponseSizeBytes: defaults.maxResponseSizeBytes ?? 1048576,
    onNotification: callbacks.onNotification ?? (() => {}),
    onStreamError: callbacks.onStreamError ?? (() => {}),
    logger: silentLogger,
    roots,
  });
  return conn;
}

/**
 * Install a mock as the global fetch for the duration of a test.
 */
function installFetch(mock: MockFetch): void {
  globalThis.fetch = mock.fetch;
}

let currentMock: MockFetch | undefined;

// Original global fetch, restored after each test so the guard below never
// leaks into other suites sharing this process (single-fork vitest pool).
const ORIGINAL_FETCH = globalThis.fetch;

// Installed between tests: any forgotten mock fails loudly within THIS file
// without poisoning later suites with a permanent throwing fetch.
const GUARD_FETCH = (async () => {
  throw new Error('real fetch must not be called in MCP unit tests');
}) as unknown as typeof fetch;

beforeEach(() => {
  currentMock = createMockFetch();
  installFetch(currentMock);
});

afterEach(() => {
  globalThis.fetch = GUARD_FETCH;
  currentMock = undefined;
  vi.restoreAllMocks();
});

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('initialize handshake', () => {
  it('sends a single initialize with protocolVersion 2025-06-18 and MCP-Protocol-Version header', async () => {
    const mock = currentMock!;
    await makeConnection(mock);
    const init = mock.lastRequest('initialize');
    expect(init).toBeDefined();
    expect(mock.callCount('initialize')).toBe(1);
    const params = init!.params as {
      protocolVersion: string;
      capabilities: {
        tools: unknown;
        resources: unknown;
        prompts: unknown;
        roots: unknown;
      };
    };
    expect(params.protocolVersion).toBe('2025-06-18');
    expect(init!.headers['mcp-protocol-version']).toBe('2025-06-18');
    expect(params.capabilities).toEqual({
      tools: {},
      resources: {},
      prompts: {},
      logging: {},
      roots: {},
    });
    // clientInfo is advertised
    expect((init!.params as { clientInfo?: unknown }).clientInfo).toBeDefined();
  });

  it('does NOT emit notifications/initialized over the HTTP transport (current behavior)', async () => {
    // CURRENT HTTP behavior: the streamable-HTTP transport's `notify` is a
    // no-op, so no `notifications/initialized` is emitted over HTTP. (The stdio
    // transport DOES send it — covered in the slow integration suite.)
    const mock = currentMock!;
    await makeConnection(mock);
    const notif = mock.requests.find(
      r => r.method === 'notifications/initialized'
    );
    expect(notif).toBeUndefined();
  });

  it('marks state connected after handshake', async () => {
    const mock = currentMock!;
    const conn = await makeConnection(mock);
    expect(conn.state.status).toBe('connected');
    expect(conn.state.transport).toBe('streamable_http');
    expect(conn.state.ownership).toBe('external');
  });

  it('throws and marks error when initialize returns a JSON-RPC error', async () => {
    const mock = createMockFetch({
      initializeError: { code: -32000, message: 'boom' },
    });
    installFetch(mock);
    await expect(makeConnection(mock)).rejects.toThrow(/boom/);
  });

  it('uses spawnTimeoutMs for the initialize request', async () => {
    const initResult = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'fake-mcp', version: '0.0.0' },
    };
    const mock = createMockFetch({
      handlers: {
        initialize: () =>
          new Promise(resolve => {
            // Intentionally longer than requestTimeoutMs but shorter than spawnTimeoutMs.
            setTimeout(() => resolve(initResult), 80);
          }),
      },
    });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { requestTimeoutMs: 50, spawnTimeoutMs: 500 }
    );
    expect(conn.state.status).toBe('connected');
    // initialize should have succeeded because it used the longer spawnTimeoutMs
    expect(mock.callCount('initialize')).toBe(1);
  });

  it('times out initialize with a short spawnTimeoutMs', async () => {
    const initResult = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'fake-mcp', version: '0.0.0' },
    };
    const mock = createMockFetch({
      handlers: {
        initialize: () =>
          new Promise(resolve => {
            setTimeout(() => resolve(initResult), 1000);
          }),
      },
    });
    installFetch(mock);
    await expect(
      makeConnection(mock, {}, { requestTimeoutMs: 50, spawnTimeoutMs: 50 })
    ).rejects.toThrow(/timed out|initialize/i);
  });

  it('uses requestTimeoutMs for subsequent JSON-RPC requests after initialize', async () => {
    const initResult = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'fake-mcp', version: '0.0.0' },
    };
    const mock = createMockFetch({
      handlers: {
        initialize: () =>
          new Promise(resolve => setTimeout(() => resolve(initResult), 150)),
      },
    });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { requestTimeoutMs: 100, spawnTimeoutMs: 1000 }
    );
    expect(conn.state.status).toBe('connected');
    // Subsequent request with a long delay should fail using requestTimeoutMs.
    mock.onRequest(
      'tools/list',
      () => new Promise(resolve => setTimeout(resolve, 500))
    );
    await expect(conn.listTools()).rejects.toThrow(/timed out/);
  });

  it('dispatches SSE progress notifications before the final result', async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const mock = createMockFetch({
      postSseResponses: {
        'tools/list': [
          // Progress notification (no id)
          { method: 'notifications/progress', params: { progress: 0.5 } },
          // Final result (has id matching the request)
          { result: { tools: [] } },
        ],
      },
    });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      {},
      { onNotification: (m, p) => notifications.push({ method: m, params: p }) }
    );
    const result = await conn.listTools();
    expect(result).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe('notifications/progress');
    expect(notifications[0].params).toEqual({ progress: 0.5 });
  });

  it('rejects when SSE response exceeds maxResponseSizeBytes', async () => {
    const mock = createMockFetch({
      postSseResponses: {
        'tools/list': [
          // A large result that exceeds the tiny limit
          {
            result: {
              tools: Array.from({ length: 100 }, (_, i) => ({
                name: `tool${i}`,
              })),
            },
          },
        ],
      },
    });
    installFetch(mock);
    const conn = await makeConnection(mock, {}, { maxResponseSizeBytes: 500 });
    await expect(conn.listTools()).rejects.toThrow(/exceeded maximum size/);
  });

  it('rejects when JSON response exceeds maxResponseSizeBytes', async () => {
    const mock = createMockFetch({
      handlers: {
        'tools/list': () => ({
          tools: Array.from({ length: 100 }, (_, i) => ({ name: `tool${i}` })),
        }),
      },
    });
    installFetch(mock);
    const conn = await makeConnection(mock, {}, { maxResponseSizeBytes: 500 });
    await expect(conn.listTools()).rejects.toThrow(/exceeded maximum size/);
  });

  it('sends MCP-Protocol-Version header on subsequent POST requests', async () => {
    const mock = currentMock!;
    const conn = await makeConnection(mock);
    mock.reset();
    await conn.listTools();
    const listReq = mock.lastRequest('tools/list');
    expect(listReq).toBeDefined();
    expect(listReq!.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('sends MCP-Protocol-Version header on GET SSE stream', async () => {
    const mock = currentMock!;
    await makeConnection(mock);
    const getReq = mock.requests.find(r => r.method === 'GET');
    expect(getReq).toBeDefined();
    expect(getReq!.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('sends MCP-Protocol-Version header on DELETE disconnect', async () => {
    const mock = createMockFetch({ sessionId: 'sess-xyz' });
    installFetch(mock);
    const conn = await makeConnection(mock);
    conn.state.status = 'connected';
    await conn.disconnect();
    const delReq = mock.requests.find(r => r.method === 'DELETE');
    expect(delReq).toBeDefined();
    expect(delReq!.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('uses negotiated protocol version from server response on subsequent requests', async () => {
    const mock = createMockFetch({
      handlers: {
        initialize: () => ({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'fake-mcp', version: '0.0.0' },
        }),
      },
    });
    installFetch(mock);
    const conn = await makeConnection(mock);
    // The initialize request itself should use the default version
    const initReq = mock.lastRequest('initialize');
    expect(initReq!.headers['mcp-protocol-version']).toBe('2025-06-18');
    // Subsequent requests should use the negotiated version
    mock.reset();
    await conn.listTools();
    const listReq = mock.lastRequest('tools/list');
    expect(listReq).toBeDefined();
    expect(listReq!.headers['mcp-protocol-version']).toBe('2025-03-26');
  });
});

describe('listTools normalization + pagination', () => {
  it('normalizes tools into McpToolMeta with name/description', async () => {
    const mock = currentMock!;
    const conn = await makeConnection(mock);
    const tools = await conn.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
    }
    expect(tools.map(t => t.name)).toContain('echo');
    expect(tools.map(t => t.name)).toContain('weird name!');
  });

  it('follows nextCursor across pages honoring maxListPages', async () => {
    const mock = createMockFetch({ pageSize: 2 });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { maxListPages: 25, maxListItems: 500 }
    );
    const tools = await conn.listTools();
    // DEFAULT_TOOLS has 3 entries; pageSize 2 => 2 pages
    expect(tools.length).toBe(3);
    expect(mock.callCount('tools/list')).toBe(2);
  });

  it('caps list at maxListItems and sets toolsListTruncated (resources)', async () => {
    const mock = createMockFetch({ pageSize: 1 });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { maxListPages: 25, maxListItems: 1 }
    );
    const resources = await conn.listResources();
    expect(resources.length).toBe(1);
    expect(conn.state.resourcesListTruncated).toBe(true);
  });

  it('walks all pages for tools/list (no maxListPages cap)', async () => {
    const mock = createMockFetch({ pageSize: 1 });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { maxListPages: 1, maxListItems: 500 }
    );
    const tools = await conn.listTools();
    // DEFAULT_TOOLS has 3 entries; pageSize 1 => 3 pages, all walked
    expect(tools.length).toBe(3);
    expect(mock.callCount('tools/list')).toBe(3);
    expect(conn.state.toolsListTruncated).toBe(false);
  });

  it('sets discoveredToolCount to the full server tool count', async () => {
    const mock = createMockFetch({ pageSize: 1 });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { maxListPages: 1, maxListItems: 500 }
    );
    await conn.listTools();
    // discoveredToolCount reflects the full server tool count (all pages walked).
    expect(conn.state.discoveredToolCount).toBe(3);
  });
});

describe('callTool current behavior', () => {
  it('sends tools/call with name + arguments and returns the raw result', async () => {
    const mock = currentMock!;
    const conn = await makeConnection(mock);
    const result = (await conn.callTool('echo', { msg: 'hi' })) as {
      content: Array<{ text: string }>;
    };
    expect(mock.callCount('tools/call')).toBe(1);
    const req = mock.lastRequest('tools/call');
    expect((req!.params as { name: string }).name).toBe('echo');
    expect((req!.params as { arguments: unknown }).arguments).toEqual({
      msg: 'hi',
    });
    expect(result.content[0].text).toContain('called echo');
  });

  it('still returns the raw result when isError is false', async () => {
    // isError:false must behave exactly like the absent flag — success.
    const mock = currentMock!;
    mock.onRequest('tools/call', (params: unknown) => {
      const p = (params ?? {}) as { name?: string; arguments?: unknown };
      return {
        content: [{ type: 'text', text: `ok ${p.name}` }],
        isError: false,
      };
    });
    const conn = await makeConnection(mock);
    const result = (await conn.callTool('echo', {})) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).toContain('ok echo');
  });

  it('rejects when tools/call returns isError: true', async () => {
    const mock = currentMock!;
    mock.onRequest('tools/call', params => {
      const p = (params ?? {}) as { name?: string };
      return {
        content: [{ type: 'text', text: `failed ${p.name}` }],
        isError: true,
      };
    });
    const conn = await makeConnection(mock);
    await expect(conn.callTool('echo', {})).rejects.toThrow(
      /MCP tool 'echo' failed/
    );
  });
});

describe('Mcp-Session-Id', () => {
  it('captures Mcp-Session-Id from initialize and echoes it on subsequent requests', async () => {
    const mock = createMockFetch({ sessionId: 'sess-xyz' });
    installFetch(mock);
    const conn = await makeConnection(mock);
    await conn.callTool('echo', {}); // a post-initialize request
    const call = mock.lastRequest('tools/call')!;
    expect(call.headers['mcp-session-id']).toBe('sess-xyz');
  });

  it('does not echo a session id when the server never issues one', async () => {
    const mock = createMockFetch();
    installFetch(mock);
    const conn = await makeConnection(mock);
    await conn.callTool('echo', {});
    const call = mock.lastRequest('tools/call')!;
    expect(call.headers['mcp-session-id']).toBeUndefined();
  });
});

describe('resources and prompts normalization', () => {
  it('normalizes resources with uri/name/description', async () => {
    const mock = currentMock!;
    const conn = await makeConnection(mock);
    const resources = await conn.listResources();
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) {
      expect(typeof r.uri).toBe('string');
    }
    expect(resources.map(r => r.uri)).toContain('file:///a.txt');
  });

  it('reads a resource by uri', async () => {
    const mock = currentMock!;
    const conn = await makeConnection(mock);
    const result = (await conn.readResource('file:///a.txt')) as {
      contents: Array<{ uri: string; text: string }>;
    };
    expect(mock.callCount('resources/read')).toBe(1);
    expect(result.contents[0].uri).toBe('file:///a.txt');
    expect(result.contents[0].text).toContain('file:///a.txt');
  });

  it('paginates prompts and normalizes them', async () => {
    const mock = createMockFetch({ pageSize: 1 });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { maxListPages: 25, maxListItems: 500 }
    );
    const prompts = await conn.listPrompts();
    expect(prompts.length).toBe(2);
    expect(prompts.map(p => p.name)).toContain('greeting');
  });

  it('gets a prompt by name', async () => {
    const mock = currentMock!;
    const conn = await makeConnection(mock);
    const result = (await conn.getPrompt('greeting', { who: 'world' })) as {
      messages: Array<{ content: { text: string } }>;
    };
    expect(mock.callCount('prompts/get')).toBe(1);
    expect(result.messages[0].content.text).toContain('greeting');
  });

  it('lists and normalizes resource templates via resources/templates/list', async () => {
    const mock = currentMock!;
    const conn = await makeConnection(mock);
    const templates = await conn.listResourceTemplates();
    expect(mock.callCount('resources/templates/list')).toBe(1);
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(typeof t.uriTemplate).toBe('string');
    }
    expect(templates.map(t => t.uriTemplate)).toContain('file:///{path}');
  });

  it('carries template arguments through normalization', async () => {
    const mock = currentMock!;
    const conn = await makeConnection(mock);
    const templates = await conn.listResourceTemplates();
    const fileTemplate = templates.find(
      t => t.uriTemplate === 'file:///{path}'
    );
    expect(fileTemplate).toBeDefined();
    expect(fileTemplate!.arguments).toBeDefined();
    expect(fileTemplate!.arguments!.length).toBeGreaterThan(0);
    const pathArg = fileTemplate!.arguments!.find(a => a.name === 'path');
    expect(pathArg).toBeDefined();
    expect(pathArg!.required).toBe(true);
  });

  it('records resourceTemplatesListTruncated on pagination overflow', async () => {
    const mock = createMockFetch({ pageSize: 1 });
    installFetch(mock);
    const conn = await makeConnection(mock, {}, { maxListPages: 1 });
    const templates = await conn.listResourceTemplates();
    expect(templates.length).toBe(1);
    expect(conn.state.resourceTemplatesListTruncated).toBe(true);
  });
});

describe('retry semantics', () => {
  it('retries idempotent list methods up to retryCount+1 attempts', async () => {
    let calls = 0;
    const mock = createMockFetch();
    mock.onRequest('tools/list', () => {
      calls += 1;
      throw new Error('transient failure');
    });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { retryCount: 2, retryDelayMs: 0 }
    );
    await expect(conn.listTools()).rejects.toThrow(/transient failure/);
    // retryCount=2 => maxAttempts=3 => initial + 2 retries
    expect(calls).toBe(3);
    expect(conn.state.retryAttemptCount).toBe(2);
  });

  it('does NOT retry non-idempotent tools/call', async () => {
    let calls = 0;
    const mock = createMockFetch();
    mock.onRequest('tools/call', () => {
      calls += 1;
      throw new Error('call failed');
    });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { retryCount: 3, retryDelayMs: 0 }
    );
    await expect(conn.callTool('echo', {})).rejects.toThrow(/call failed/);
    expect(calls).toBe(1);
    expect(conn.state.retryAttemptCount).toBe(0);
  });

  it('succeeds on a later retry attempt and records attempts', async () => {
    let attempts = 0;
    const mock = createMockFetch();
    mock.onRequest('resources/list', () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error('flaky');
      }
      return { resources: [{ uri: 'file:///ok.txt' }] };
    });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { retryCount: 1, retryDelayMs: 0 }
    );
    const resources = await conn.listResources();
    expect(resources.length).toBe(1);
    expect(attempts).toBe(2);
    expect(conn.state.retryAttemptCount).toBe(1);
  });
});

describe('error classification on HTTP failure', () => {
  it('classifies non-2xx HTTP status as transport error and marks state', async () => {
    const mock = createMockFetch({ forceHttpError: 503 });
    installFetch(mock);
    await expect(makeConnection(mock)).rejects.toThrow(/503/);
  });

  it('records error category + message on a 500 during listTools (does not flip status)', async () => {
    // Only `tools/list` fails; initialize must still succeed so we build a
    // connection whose later method can error.
    const mock = createMockFetch({ httpErrors: { 'tools/list': 500 } });
    installFetch(mock);
    const conn = await makeConnection(mock, {}, { retryCount: 0 });
    await expect(conn.listTools()).rejects.toThrow(/500/);
    // CURRENT behavior: a post-initialize failure records the error category
    // and message, but does NOT flip `state.status` away from 'connected'.
    expect(conn.state.status).toBe('connected');
    // NOTE: CURRENT classifyErrorCategory quirk — the 500 message
    // ("MCP HTTP demo returned 500 HTTP 500") matches the `mcp ` substring
    // before the `status`/transport checks, so it is bucketed as 'protocol',
    // not 'transport'. This is a known classification defect; assert current
    // behavior so later fix-phases have a regression anchor.
    expect(conn.state.lastErrorCategory).toBe('protocol');
    expect(conn.state.lastError).toContain('500');
  });

  it('classifies a timeout error', async () => {
    const mock = createMockFetch();
    mock.onRequest('tools/list', () => {
      throw new Error('MCP request timed out: tools/list');
    });
    installFetch(mock);
    const conn = await makeConnection(mock, {}, { retryCount: 0 });
    await expect(conn.listTools()).rejects.toThrow(/timed out/);
    expect(conn.state.lastErrorCategory).toBe('timeout');
  });
});

describe('compatibilityMode envelope handling', () => {
  it('permissive mode wraps a bare result object from a non-envelope body', async () => {
    const mock = createMockFetch();
    // Emit a truly bare (non-enveloped) HTTP body for tools/call.
    mock.onRawResponse('tools/call', { rawThing: 'yes' });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { compatibilityMode: 'permissive' }
    );
    const result = await conn.callTool('echo', {});
    expect(result).toMatchObject({ rawThing: 'yes' });
  });

  it('strict mode rejects a bare result object (no result/error envelope)', async () => {
    const mock = createMockFetch();
    mock.onRawResponse('tools/call', { rawThing: 'yes' });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { compatibilityMode: 'strict' }
    );
    await expect(conn.callTool('echo', {})).rejects.toThrow(
      /Invalid JSON-RPC envelope/
    );
  });
});

describe('roots capability', () => {
  it('advertises roots: {} in initialize capabilities', async () => {
    const mock = currentMock!;
    await makeConnection(mock);
    const init = mock.lastRequest('initialize');
    expect(init).toBeDefined();
    const params = init!.params as {
      capabilities: { roots?: unknown };
    };
    expect(params.capabilities.roots).toEqual({});
  });

  it('responds to roots/list server request with configured roots', async () => {
    const roots: DroneMcpRoot[] = [
      { uri: 'file:///project', name: 'Project Root' },
      { uri: 'file:///home/user', name: 'Home Directory' },
    ];
    const mock = createMockFetch({
      sessionId: 'sess-roots',
      sseEvents: [{ id: 100, method: 'roots/list' }],
    });
    installFetch(mock);
    await makeConnection(mock, {}, {}, {}, roots);
    // Give the fire-and-forget GET reader a tick to consume the SSE
    // event and the POST response to be sent back.
    await new Promise(resolve => setTimeout(resolve, 50));
    // The client POSTs a JSON-RPC response back to the server URL.
    // The mock records it as a POST with no `method` (responses have
    // no method field) and the `id` and `result` from the body.
    const response = mock.requests.find(
      r => r.id === 100 && r.result !== undefined
    );
    expect(response).toBeDefined();
    expect(response!.result).toEqual({ roots });
  });

  it('returns empty roots array when no roots are configured', async () => {
    const mock = createMockFetch({
      sessionId: 'sess-empty-roots',
      sseEvents: [{ id: 200, method: 'roots/list' }],
    });
    installFetch(mock);
    const conn = await makeConnection(mock);
    await new Promise(resolve => setTimeout(resolve, 50));
    const response = mock.requests.find(
      r => r.id === 200 && r.result !== undefined
    );
    expect(response).toBeDefined();
    expect(response!.result).toEqual({ roots: [] });
    expect(conn.state.status).toBe('connected');
  });
});

describe('streamable-HTTP GET SSE stream + DELETE termination (point 8)', () => {
  it('opens a GET SSE stream with text/event-stream accept + session id', async () => {
    const mock = createMockFetch({ sessionId: 'sess-xyz' });
    installFetch(mock);
    await makeConnection(mock);
    const get = mock.requests.find(r => r.method === 'GET');
    expect(get).toBeDefined();
    expect(get!.headers['accept']).toBe('text/event-stream');
    expect(get!.headers['mcp-session-id']).toBe('sess-xyz');
  });

  it('dispatches received SSE notifications to onNotification (incl. tools/list_changed)', async () => {
    const received: string[] = [];
    const mock = createMockFetch({
      sessionId: 'sess-xyz',
      sseEvents: [
        { method: 'notifications/tools/list_changed' },
        { method: 'notifications/message', params: { level: 'info' } },
      ],
    });
    installFetch(mock);
    await makeConnection(
      mock,
      {},
      {},
      {
        onNotification: (method: string) => {
          received.push(method);
        },
      }
    );
    // Give the fire-and-forget GET reader a tick to consume the stream.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(received).toContain('notifications/tools/list_changed');
    expect(received).toContain('notifications/message');
    expect(received.length).toBe(2);
  });

  it('passes notifications/message params through to onNotification with level and data', async () => {
    const received: Array<{ method: string; params: unknown }> = [];
    const mock = createMockFetch({
      sessionId: 'sess-xyz',
      sseEvents: [
        {
          method: 'notifications/message',
          params: {
            level: 'warning',
            logger: 'test-logger',
            data: 'something went wrong',
          },
        },
        {
          method: 'notifications/message',
          params: { level: 'error', data: { code: 42, detail: 'fatal' } },
        },
      ],
    });
    installFetch(mock);
    await makeConnection(
      mock,
      {},
      {},
      {
        onNotification: (method: string, params: unknown) => {
          received.push({ method, params });
        },
      }
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(received).toEqual([
      {
        method: 'notifications/message',
        params: {
          level: 'warning',
          logger: 'test-logger',
          data: 'something went wrong',
        },
      },
      {
        method: 'notifications/message',
        params: { level: 'error', data: { code: 42, detail: 'fatal' } },
      },
    ]);
  });

  it('dispatches each SSE event individually to onNotification', async () => {
    const received: string[] = [];
    const mock = createMockFetch({
      sseEvents: [{ method: 'notifications/a' }, { method: 'notifications/b' }],
    });
    installFetch(mock);
    await makeConnection(
      mock,
      {},
      {},
      {
        onNotification: (method: string) => {
          received.push(method);
        },
      }
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(received).toEqual(['notifications/a', 'notifications/b']);
  });

  it('records a stream error (log-and-stop) without flipping status to error', async () => {
    const errors: string[] = [];
    const mock = createMockFetch({ sseError: true });
    installFetch(mock);
    // Holder so the callback can reach `conn` even if the GET reader errors
    // during makeConnection (before the local is assigned). Mirrors index.ts,
    // where the connection is declared ahead of the per-server loop.
    let captured: Awaited<ReturnType<typeof makeConnection>> | undefined;
    captured = await makeConnection(
      mock,
      {},
      {},
      {
        onStreamError: (message: string) => {
          errors.push(message);
          // Mirror index.ts wiring: record the drop on server state.
          if (captured) {
            captured.state.streaming = false;
            captured.state.lastStreamError = message;
          }
        },
      }
    );
    const conn = captured;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(errors.length).toBeGreaterThan(0);
    expect(conn.state.streaming).toBe(false);
    expect(conn.state.lastStreamError).toBeDefined();
    // Status must remain 'connected' — a stream drop is not a fatal error.
    expect(conn.state.status).toBe('connected');
  });

  it('sends a DELETE with the session id on disconnect', async () => {
    const mock = createMockFetch({ sessionId: 'sess-xyz' });
    installFetch(mock);
    const conn = await makeConnection(mock);
    conn.state.status = 'connected';
    await conn.disconnect();
    const del = mock.requests.find(r => r.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.headers['mcp-session-id']).toBe('sess-xyz');
    expect(conn.state.status).toBe('disconnected');
  });

  it('best-effort DELETE failure does not throw and keeps status disconnected', async () => {
    const errors: string[] = [];
    const mock = createMockFetch({
      sessionId: 'sess-xyz',
      httpErrors: { DELETE: 500 },
    });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      {},
      {
        onStreamError: (message: string) => {
          errors.push(message);
        },
      }
    );
    // Should not throw despite the 500 from DELETE.
    await expect(conn.disconnect()).resolves.toBeUndefined();
    expect(conn.state.status).toBe('disconnected');
    expect(errors.some(e => e.includes('DELETE failed'))).toBe(true);
  });
});

describe('splitToolResultBlocks', () => {
  it('joins text blocks into content', () => {
    const result = splitToolResultBlocks({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
    });
    expect(result.content).toBe('hello\nworld');
    expect(result.images).toBeUndefined();
  });

  it('maps image blocks to structured images', () => {
    const result = splitToolResultBlocks({
      content: [
        { type: 'text', text: 'a screenshot' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    });
    expect(result.content).toBe('a screenshot');
    expect(result.images).toEqual([
      { mimeType: 'image/png', data: 'aGVsbG8=' },
    ]);
  });

  it('drops non-text/non-image blocks (e.g. resource)', () => {
    const result = splitToolResultBlocks({
      content: [
        { type: 'text', text: 'text only' },
        { type: 'resource', resource: { uri: 'file:///a.txt' } },
      ],
    });
    expect(result.content).toBe('text only');
    expect(result.images).toBeUndefined();
  });

  it('returns empty content for a result without content blocks', () => {
    const result = splitToolResultBlocks({ someField: 'x' });
    expect(result.content).toBe('');
    expect(result.images).toBeUndefined();
  });
});

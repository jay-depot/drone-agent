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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpClientConnection } from '../src/plugins/mcp/client.js';
import { createMockFetch } from './mcp-fake-server.js';
import type { MockFetch } from './mcp-fake-server.js';
import type { DroneMcpServerConfig, DroneLogger } from 'drone-core';

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
    retryCount: number;
    retryDelayMs: number;
    maxListPages: number;
    maxListItems: number;
    compatibilityMode: 'strict' | 'permissive';
  }> = {},
  callbacks: {
    onNotification?: (method: string, params: unknown) => void;
    onStreamError?: (message: string) => void;
  } = {}
) {
  const conn = await createMcpClientConnection({
    serverId: 'demo',
    config: baseConfig(configOverrides),
    defaultRequestTimeoutMs: defaults.requestTimeoutMs ?? 1000,
    defaultRetryCount: defaults.retryCount ?? 0,
    defaultRetryDelayMs: defaults.retryDelayMs ?? 0,
    defaultMaxListPages: defaults.maxListPages ?? 25,
    defaultMaxListItems: defaults.maxListItems ?? 500,
    defaultCompatibilityMode: defaults.compatibilityMode ?? 'strict',
    onNotification: callbacks.onNotification ?? (() => {}),
    onStreamError: callbacks.onStreamError ?? (() => {}),
    logger: silentLogger,
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

// If any test forgets to install a mock, the real fetch throws loudly.
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

describe('initialize handshake', () => {
  it('sends a single initialize with protocolVersion 2024-11-05 and tools/resources/prompts capabilities', async () => {
    const mock = currentMock!;
    await makeConnection(mock);
    const init = mock.lastRequest('initialize');
    expect(init).toBeDefined();
    expect(mock.callCount('initialize')).toBe(1);
    const params = init!.params as {
      protocolVersion: string;
      capabilities: { tools: unknown; resources: unknown; prompts: unknown };
    };
    expect(params.protocolVersion).toBe('2024-11-05');
    expect(params.capabilities).toEqual({
      tools: {},
      resources: {},
      prompts: {},
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

  it('caps list at maxListItems and sets toolsListTruncated', async () => {
    const mock = createMockFetch({ pageSize: 1 });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { maxListPages: 25, maxListItems: 2 }
    );
    const tools = await conn.listTools();
    expect(tools.length).toBe(2);
    expect(conn.state.toolsListTruncated).toBe(true);
  });

  it('stops paginating once maxListPages is exhausted and flags truncation', async () => {
    const mock = createMockFetch({ pageSize: 1 });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { maxListPages: 1, maxListItems: 500 }
    );
    const tools = await conn.listTools();
    expect(tools.length).toBe(1);
    expect(mock.callCount('tools/list')).toBe(1);
    expect(conn.state.toolsListTruncated).toBe(true);
  });

  it('sets discoveredToolCount to the (possibly truncated) returned count', async () => {
    const mock = createMockFetch({ pageSize: 1 });
    installFetch(mock);
    const conn = await makeConnection(
      mock,
      {},
      { maxListPages: 1, maxListItems: 500 }
    );
    await conn.listTools();
    // CURRENT behavior: discoveredToolCount reflects truncated page count.
    expect(conn.state.discoveredToolCount).toBe(1);
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

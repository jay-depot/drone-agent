import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';
import { setCoordinatorClient } from '../src/routes/context.js';
import type { CoordinatorClient } from '../src/coordinator-client.js';

const sendToAgent = vi.fn();

vi.mock('../src/ws-server.js', () => ({
  isLocalConnection: vi.fn().mockReturnValue(true),
  isAgentConnected: vi.fn().mockReturnValue(true),
  getConnectedAgents: vi.fn().mockReturnValue([]),
  getConnection: vi.fn().mockReturnValue(undefined),
  sendToAgent: (...args: unknown[]) => sendToAgent(...args),
  sendToChannel: vi.fn(),
  registerWebSocketServer: vi.fn(),
  startMessageCleanup: vi.fn(),
}));

const { handleInject, handleInjectRemove } =
  await import('../src/routes/extension-handlers.js');

let app: FastifyInstance;

function makeFakeClient(
  overrides: Partial<CoordinatorClient> = {}
): CoordinatorClient {
  return {
    getBaseUrl: () => 'http://coordinator:3456',
    getFetch: () => fetch as typeof fetch,
    ...overrides,
  } as unknown as CoordinatorClient;
}

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
  sendToAgent.mockReset();
  sendToAgent.mockReturnValue(true);
});

afterEach(async () => {
  setCoordinatorClient(undefined);
  await app.close();
  await teardownDb();
});

describe('beacon inject command handler', () => {
  it('relays an injection frame to the target agent', () => {
    const result = handleInject({
      extensionId: 'node-1',
      target: 'agent-1',
      kind: 'fragment',
      id: 'inj-1',
      content: '# Hello',
    });
    expect(result.status).toBe(200);
    expect(sendToAgent).toHaveBeenCalledWith('agent-1', {
      type: 'injection',
      payload: expect.objectContaining({
        extensionId: 'node-1',
        kind: 'fragment',
        id: 'inj-1',
        content: '# Hello',
      }),
    });
  });

  it('relays an injection-remove frame to the target agent', () => {
    const result = handleInjectRemove({
      extensionId: 'node-1',
      target: 'agent-1',
      kind: 'fragment',
      injectionId: 'inj-1',
    });
    expect(result.status).toBe(200);
    expect(sendToAgent).toHaveBeenCalledWith('agent-1', {
      type: 'injectionRemove',
      payload: expect.objectContaining({ injectionId: 'inj-1' }),
    });
  });

  it('400s when target is missing', () => {
    const result = handleInject({
      extensionId: 'node-1',
      target: '',
      kind: 'fragment',
    });
    expect(result.status).toBe(400);
    expect(sendToAgent).not.toHaveBeenCalled();
  });
});

describe('POST /coordinator/extensions/:nodeId/tools/:tool (beacon proxy)', () => {
  it('returns 503 when no coordinator client is configured', async () => {
    setCoordinatorClient(undefined);
    const res = await app.inject({
      method: 'POST',
      url: '/coordinator/extensions/node-1/tools/echo',
      payload: { params: {}, sessionId: 'sess-1' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('forwards the tool call through the coordinator client', async () => {
    const invokeExtensionTool = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { result: 42 },
    });
    setCoordinatorClient(
      makeFakeClient({ invokeExtensionTool } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'POST',
      url: '/coordinator/extensions/node-1/tools/echo',
      payload: { params: { q: 'hi' }, sessionId: 'sess-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(invokeExtensionTool).toHaveBeenCalledWith(
      'node-1',
      'echo',
      { q: 'hi' },
      'sess-1'
    );
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      status: 200,
      body: { result: 42 },
    });
  });
});

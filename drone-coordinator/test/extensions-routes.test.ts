import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';
import type { DroneExtensionManifest } from 'drone-core';
import {
  setManifest,
  resetExtensionRegistry,
} from '../src/extension-registry.js';
import { getBundle, listBundles } from '../src/db/index.js';

const sendBeaconCommand = vi.fn();
const isBeaconConnected = vi.fn();
const resolveRequestNodeId = vi.fn();

vi.mock('../src/beacon-ws.js', () => ({
  sendBeaconCommand: (...args: unknown[]) => sendBeaconCommand(...args),
  isBeaconConnected: (...args: unknown[]) => isBeaconConnected(...args),
}));

vi.mock('../src/mtls.js', () => ({
  resolveRequestNodeId: (...args: unknown[]) => resolveRequestNodeId(...args),
}));

let app: FastifyInstance;

function manifest(): DroneExtensionManifest {
  return {
    protocolVersion: 1,
    capabilities: [
      {
        name: 'echo',
        description: 'Echo back the input',
        paramSchema: {
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string' } },
        },
        timeoutMs: 1000,
      },
    ],
    bundles: [],
  };
}

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
  resetExtensionRegistry();
  sendBeaconCommand.mockReset();
  isBeaconConnected.mockReset();
  resolveRequestNodeId.mockReset();
  isBeaconConnected.mockReturnValue(true);
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

describe('GET /api/extensions', () => {
  it('lists connected extensions with capabilities', async () => {
    setManifest('node-1', manifest());
    const res = await app.inject({ method: 'GET', url: '/api/extensions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      nodeId: 'node-1',
      connected: true,
      isExtension: true,
    });
    expect(body[0].capabilities[0].name).toBe('echo');
  });

  it('returns an empty list when nothing is registered', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/extensions' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});

describe('POST /api/extensions/:nodeId/actions/:action', () => {
  it('invokes a capability and passes the result through', async () => {
    setManifest('node-1', manifest());
    sendBeaconCommand.mockResolvedValue({
      ok: true,
      status: 200,
      body: { echoed: 'hi' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/node-1/actions/echo',
      payload: { params: { q: 'hi' } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      status: 200,
      body: { echoed: 'hi' },
    });
    expect(sendBeaconCommand).toHaveBeenCalledWith(
      'node-1',
      'invokeAction',
      {
        action: 'echo',
        params: { q: 'hi' },
        caller: 'ui',
        sessionId: undefined,
      },
      1000
    );
  });

  it('400s when params fail the paramSchema', async () => {
    setManifest('node-1', manifest());
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/node-1/actions/echo',
      payload: { params: { q: 5 } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).details[0]).toContain('params.q');
    expect(sendBeaconCommand).not.toHaveBeenCalled();
  });

  it('400s when a required param is missing', async () => {
    setManifest('node-1', manifest());
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/node-1/actions/echo',
      payload: { params: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for an unknown capability', async () => {
    setManifest('node-1', manifest());
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/node-1/actions/missing',
      payload: { params: {} },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('UNKNOWN_CAPABILITY');
  });

  it('404s when the node is not an extension', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/node-1/actions/echo',
      payload: { params: {} },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('NOT_EXTENSION');
  });

  it('503s when the node is disconnected', async () => {
    setManifest('node-1', manifest());
    isBeaconConnected.mockReturnValue(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/node-1/actions/echo',
      payload: { params: { q: 'hi' } },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('EXTENSION_DISCONNECTED');
  });

  it('504s on a timeout', async () => {
    setManifest('node-1', manifest());
    sendBeaconCommand.mockRejectedValue(
      new Error('Timed out waiting for beacon response')
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/node-1/actions/echo',
      payload: { params: { q: 'hi' } },
    });
    expect(res.statusCode).toBe(504);
    expect(JSON.parse(res.body).code).toBe('EXTENSION_TIMEOUT');
  });
});

describe('POST /api/extensions/:nodeId/tools/:tool', () => {
  it('invokes a tool with caller=agent', async () => {
    setManifest('node-1', manifest());
    sendBeaconCommand.mockResolvedValue({ ok: true, status: 200, body: 'r' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/node-1/tools/echo',
      payload: { params: { q: 'hi' }, sessionId: 'sess-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(sendBeaconCommand).toHaveBeenCalledWith(
      'node-1',
      'invokeTool',
      {
        action: 'echo',
        params: { q: 'hi' },
        caller: 'agent',
        sessionId: 'sess-1',
      },
      1000
    );
  });

  it('400s when tool params fail the schema', async () => {
    setManifest('node-1', manifest());
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/node-1/tools/echo',
      payload: { params: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('bundle upload / serving / delete', () => {
  const files = [
    {
      name: 'index.js',
      contentBase64: Buffer.from('export default {}').toString('base64'),
    },
    {
      name: 'style.css',
      contentBase64: Buffer.from('body{}').toString('base64'),
    },
  ];

  it('uploads a bundle and records the DB row', async () => {
    resolveRequestNodeId.mockReturnValue('node-1');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      payload: { version: '1.0.0', files },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('panel');
    expect(body.version).toBe('1.0.0');
    expect(body.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(getBundle('node-1', 'panel')?.hash).toBe(body.hash);
  });

  it('401s when no node certificate is presented', async () => {
    resolveRequestNodeId.mockReturnValue(undefined);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      payload: { version: '1.0.0', files },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400s when files are missing', async () => {
    resolveRequestNodeId.mockReturnValue('node-1');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      payload: { version: '1.0.0' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('serves the uploaded bundle file same-origin', async () => {
    resolveRequestNodeId.mockReturnValue('node-1');
    const upload = await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      payload: { version: '1.0.0', files },
    });
    const { hash } = JSON.parse(upload.body);
    const res = await app.inject({
      method: 'GET',
      url: `/plugin-scripts/node-1/${hash}/index.js`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('export default');
    expect(res.headers['content-type']).toContain('application/javascript');

    const css = await app.inject({
      method: 'GET',
      url: `/plugin-styles/node-1/${hash}/style.css`,
    });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
  });

  it('404s for an unregistered bundle hash', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/plugin-scripts/node-1/${'a'.repeat(64)}/index.js`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects path traversal in the file name', async () => {
    resolveRequestNodeId.mockReturnValue('node-1');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      payload: {
        version: '1.0.0',
        files: [
          {
            name: '../evil.js',
            contentBase64: Buffer.from('x').toString('base64'),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('deletes a bundle (row + disk)', async () => {
    resolveRequestNodeId.mockReturnValue('node-1');
    await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      payload: { version: '1.0.0', files },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/extensions/bundles/panel',
    });
    expect(res.statusCode).toBe(200);
    expect(getBundle('node-1', 'panel')).toBeUndefined();
  });

  it('replaces a bundle and drops the superseded directory', async () => {
    resolveRequestNodeId.mockReturnValue('node-1');
    const first = await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      payload: { version: '1.0.0', files },
    });
    const firstHash = JSON.parse(first.body).hash;
    const second = await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      payload: {
        version: '2.0.0',
        files: [
          {
            name: 'index.js',
            contentBase64: Buffer.from('export default {v:2}').toString(
              'base64'
            ),
          },
        ],
      },
    });
    const secondHash = JSON.parse(second.body).hash;
    expect(secondHash).not.toBe(firstHash);
    expect(listBundles('node-1')).toHaveLength(1);
    expect(getBundle('node-1', 'panel')?.version).toBe('2.0.0');
    // The superseded hash no longer serves.
    const stale = await app.inject({
      method: 'GET',
      url: `/plugin-scripts/node-1/${firstHash}/index.js`,
    });
    expect(stale.statusCode).toBe(404);
  });
});

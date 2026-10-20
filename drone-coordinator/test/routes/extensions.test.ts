import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import { registerBeaconTrust } from '../../src/db/index.js';
import type { FastifyInstance } from 'fastify';

const files = [
  {
    name: 'index.js',
    contentBase64: Buffer.from('export default {}').toString('base64'),
  },
];

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
  registerBeaconTrust(
    {
      id: 'mcp-swarm',
      name: 'mcp-swarm',
      host: '127.0.0.1',
      publicKey: 'key-ext',
    },
    { socketIsLocal: true }
  );
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

describe('bundle upload/delete with a claimed node id', () => {
  it('uploads a bundle for a local caller that claims a registered id', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      headers: { 'x-node-id': 'mcp-swarm' },
      payload: { version: '1.0.0', files },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('panel');
  });

  it('deletes a bundle for a local caller that claims a registered id', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      headers: { 'x-node-id': 'mcp-swarm' },
      payload: { version: '1.0.0', files },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/extensions/bundles/panel',
      headers: { 'x-node-id': 'mcp-swarm' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('401s when the claimed id is unknown', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      headers: { 'x-node-id': 'nope' },
      payload: { version: '1.0.0', files },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s when no claim is presented', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/extensions/bundles/panel',
      payload: { version: '1.0.0', files },
    });
    expect(res.statusCode).toBe(401);
  });
});

import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCoordinatorFetch } from '../src/coordinator-fetch.js';

const servers: http.Server[] = [];

const startServer = async (
  handler: http.RequestListener
): Promise<{ url: string; server: http.Server }> => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

describe('createCoordinatorFetch', () => {
  it('resolves a normal response', async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const res = await createCoordinatorFetch(url)('/api/beacons');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects with a clear message when the response exceeds timeoutMs', async () => {
    const { url } = await startServer(() => {
      // Deliberately never respond.
    });

    const fetchFn = createCoordinatorFetch(
      url,
      undefined,
      undefined,
      undefined,
      120
    );

    await expect(fetchFn('/api/beacons')).rejects.toThrow(
      'coordinator did not respond within 120 ms'
    );
  });

  it('does not time out when timeoutMs is unset', async () => {
    const { url } = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 150);
    });

    const res = await createCoordinatorFetch(url)('/api/beacons');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('late');
  });
});

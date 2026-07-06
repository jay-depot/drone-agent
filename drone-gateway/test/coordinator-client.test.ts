import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CoordinatorClient } from '../src/coordinator-client.js';

function mockFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as Response;
}

describe('CoordinatorClient', () => {
  let client: CoordinatorClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new CoordinatorClient('http://localhost:8080');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('spawnAgent', () => {
    it('sends POST to /spawn with correct body', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, {
          spawnId: 'abc',
          agentId: 'agent-1',
          status: 'running',
        })
      );

      const result = await client.spawnAgent('beacon-1', {
        personaId: 'coder',
        spawnId: 'my-spawn',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/spawn',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetBeaconId: 'beacon-1',
            personaId: 'coder',
            spawnId: 'my-spawn',
          }),
        })
      );
      expect(result).toEqual({
        spawnId: 'abc',
        agentId: 'agent-1',
        status: 'running',
      });
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(400, { error: 'bad request' })
      );

      await expect(client.spawnAgent('beacon-1')).rejects.toThrow(
        'Spawn failed (400): {"error":"bad request"}'
      );
    });
  });

  describe('listBeacons', () => {
    it('sends GET to /beacons', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, [{ id: 'beacon-1' }]));

      const result = await client.listBeacons();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/beacons',
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual([{ id: 'beacon-1' }]);
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(500, {}));

      await expect(client.listBeacons()).rejects.toThrow(
        'List beacons failed (500)'
      );
    });
  });

  describe('listAgents', () => {
    it('sends GET to /agents/location without query when no beaconId', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, []));

      await client.listAgents();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/agents/location',
        expect.anything()
      );
    });

    it('sends GET to /agents/location with beaconId query', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, []));

      await client.listAgents('beacon-1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/agents/location?beaconId=beacon-1',
        expect.anything()
      );
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(403, {}));

      await expect(client.listAgents()).rejects.toThrow(
        'List agents failed (403)'
      );
    });
  });

  describe('getSpawn', () => {
    it('sends GET to /spawn/:beaconId/:spawnId', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { status: 'running' })
      );

      const result = await client.getSpawn('beacon-1', 'spawn-1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/spawn/beacon-1/spawn-1',
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual({ status: 'running' });
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(404, {}));

      await expect(client.getSpawn('b', 's')).rejects.toThrow(
        'Get spawn failed (404)'
      );
    });
  });

  describe('listSpawns', () => {
    it('sends GET to /spawn/:beaconId without query when no status', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, []));

      await client.listSpawns('beacon-1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/spawn/beacon-1',
        expect.anything()
      );
    });

    it('sends GET to /spawn/:beaconId with status query', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, []));

      await client.listSpawns('beacon-1', 'running');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/spawn/beacon-1?status=running',
        expect.anything()
      );
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(500, {}));

      await expect(client.listSpawns('b')).rejects.toThrow(
        'List spawns failed (500)'
      );
    });
  });

  describe('terminateSpawn', () => {
    it('sends DELETE to /spawn/:beaconId/:spawnId', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { status: 'terminated' })
      );

      const result = await client.terminateSpawn('beacon-1', 'spawn-1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/spawn/beacon-1/spawn-1',
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(result).toEqual({ status: 'terminated' });
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(404, {}));

      await expect(client.terminateSpawn('b', 's')).rejects.toThrow(
        'Terminate spawn failed (404)'
      );
    });
  });

  describe('sendMessage', () => {
    it('sends POST to /messages with toAgentId and body', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { ok: true }));

      const result = await client.sendMessage('agent-1', 'Hello!');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/messages',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toAgentId: 'agent-1',
            body: JSON.stringify({ type: 'chat', text: 'Hello!' }),
          }),
        })
      );
      expect(result).toEqual({ ok: true });
    });

    it('throws on non-OK response with error text', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(400, { error: 'bad' }));

      await expect(client.sendMessage('agent-1', 'hi')).rejects.toThrow(
        'Send message failed (400): {"error":"bad"}'
      );
    });
  });

  describe('auth header', () => {
    it('includes Bearer token when provided', async () => {
      const authedClient = new CoordinatorClient(
        'http://localhost:8080',
        'my-token'
      );
      fetchMock.mockResolvedValue(mockFetchResponse(200, []));

      await authedClient.listBeacons();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer my-token',
          },
        })
      );
    });

    it('does not include Authorization header when no token', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, []));

      await client.listBeacons();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
          },
        })
      );
    });
  });
});

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

      const result = await client.spawnAgent({
        targetBeaconId: 'beacon-1',
        personaId: 'coder',
        spawnId: 'my-spawn',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/spawn',
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

      await expect(
        client.spawnAgent({ targetBeaconId: 'beacon-1' })
      ).rejects.toThrow('Spawn failed (400): {"error":"bad request"}');
    });
  });

  describe('listBeacons', () => {
    it('sends GET to /beacons', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, [{ id: 'beacon-1' }]));

      const result = await client.listBeacons();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/beacons',
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

  describe('listSpawns', () => {
    it('sends GET to /spawn/:beaconId without query when no status', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, []));

      await client.listSpawns('beacon-1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/spawn/beacon-1',
        expect.anything()
      );
    });

    it('sends GET to /spawn/:beaconId with status query', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, []));

      await client.listSpawns('beacon-1', 'running');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/spawn/beacon-1?status=running',
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
        'http://localhost:8080/api/spawn/beacon-1/spawn-1',
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
        'http://localhost:8080/api/messages/relay',
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

  describe('listSessions', () => {
    it('sends GET to /sessions with query params', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { sessions: [{ id: 's1' }], count: 1 })
      );

      const result = await client.listSessions({
        status: 'ended',
        limit: 10,
        offset: 5,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/sessions?status=ended&limit=10&offset=5',
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual({ sessions: [{ id: 's1' }], count: 1 });
    });

    it('sends GET to /sessions without query when empty', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { sessions: [], count: 0 })
      );

      await client.listSessions();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/sessions',
        expect.anything()
      );
    });

    it('defaults count to sessions length when count absent', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { sessions: [{ id: 'a' }, { id: 'b' }] })
      );

      const result = await client.listSessions();

      expect(result).toEqual({
        sessions: [{ id: 'a' }, { id: 'b' }],
        count: 2,
      });
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(500, {}));

      await expect(client.listSessions()).rejects.toThrow(
        'List sessions failed (500)'
      );
    });
  });

  describe('getSession', () => {
    it('sends GET to /sessions/:id and unwraps session', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { session: { id: 's1', status: 'ended' } })
      );

      const result = await client.getSession('s1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/sessions/s1',
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual({ id: 's1', status: 'ended' });
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(404, {}));

      await expect(client.getSession('nope')).rejects.toThrow(
        'Get session failed (404)'
      );
    });
  });

  describe('sendSessionMessage', () => {
    it('sends POST to /sessions/:id/message with content and steer', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { success: true, delivered: true })
      );

      await client.sendSessionMessage('s1', 'hello', true);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/sessions/s1/message',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ content: 'hello', steer: true }),
        })
      );
    });

    it('throws with response body on non-OK', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(400, { error: 'content is required' })
      );

      await expect(client.sendSessionMessage('s1', '', false)).rejects.toThrow(
        'Send session message failed (400): {"error":"content is required"}'
      );
    });
  });

  describe('setSessionPersona', () => {
    it('sends PATCH to /sessions/:id/persona with personaId', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { id: 's1' }));

      await client.setSessionPersona('s1', 'coder');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/sessions/s1/persona',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ personaId: 'coder' }),
        })
      );
    });

    it('sends null personaId to clear', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { id: 's1' }));

      await client.setSessionPersona('s1', null);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/sessions/s1/persona',
        expect.objectContaining({
          body: JSON.stringify({ personaId: null }),
        })
      );
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(404, {}));

      await expect(client.setSessionPersona('x', 'coder')).rejects.toThrow(
        'Set session persona failed (404)'
      );
    });
  });

  describe('broadcast', () => {
    it('sends POST to /messages/broadcast with fromAgentId, channel, body', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { success: true }));

      await client.broadcast({
        fromAgentId: 'gateway',
        channel: 'swarm-console',
        body: 'hi',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/messages/broadcast',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            fromAgentId: 'gateway',
            channel: 'swarm-console',
            body: 'hi',
          }),
        })
      );
    });

    it('throws with body on non-OK', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(400, { error: 'fromAgentId required' })
      );

      await expect(
        client.broadcast({ fromAgentId: '', channel: 'c', body: 'b' })
      ).rejects.toThrow(
        'Broadcast failed (400): {"error":"fromAgentId required"}'
      );
    });
  });

  describe('personas', () => {
    it('lists personas', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, [{ id: 'p1' }]));

      const result = await client.listPersonas();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/personas',
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual([{ id: 'p1' }]);
    });

    it('creates a persona', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(201, { id: 'p1' }));

      await client.createPersona({
        id: 'p1',
        name: 'p1',
        description: 'desc',
        systemPrompt: 'sys',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/personas',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            id: 'p1',
            name: 'p1',
            description: 'desc',
            systemPrompt: 'sys',
          }),
        })
      );
    });

    it('updates a persona', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { id: 'p1' }));

      await client.updatePersona('p1', { systemPrompt: 'new' });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/personas/p1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ systemPrompt: 'new' }),
        })
      );
    });

    it('deletes a persona', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { success: true }));

      await client.deletePersona('p1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/personas/p1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('throws on list non-OK response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(500, {}));

      await expect(client.listPersonas()).rejects.toThrow(
        'List personas failed (500)'
      );
    });
  });

  describe('skills', () => {
    it('lists skills', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, [{ id: 'k1' }]));

      const result = await client.listSkills();

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/skills',
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual([{ id: 'k1' }]);
    });

    it('creates a skill', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(201, { id: 'k1' }));

      await client.createSkill({
        id: 'k1',
        name: 'k1',
        description: 'desc',
        trigger: 'desc',
        body: 'body',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/skills',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            id: 'k1',
            name: 'k1',
            description: 'desc',
            trigger: 'desc',
            body: 'body',
          }),
        })
      );
    });

    it('updates a skill', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { id: 'k1' }));

      await client.updateSkill('k1', { body: 'new' });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/skills/k1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ body: 'new' }),
        })
      );
    });

    it('deletes a skill', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { success: true }));

      await client.deleteSkill('k1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/api/skills/k1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('throws on create non-OK response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(400, {}));

      await expect(
        client.createSkill({
          id: 'k1',
          name: 'k1',
          description: 'd',
          trigger: 't',
          body: 'b',
        })
      ).rejects.toThrow('Create skill failed (400)');
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

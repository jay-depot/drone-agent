import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockSpawnAgent = vi.fn();
const mockSendSessionMessage = vi.fn();
const mockTerminateSpawn = vi.fn();

const mockClient = {
  spawnAgent: mockSpawnAgent,
  sendSessionMessage: mockSendSessionMessage,
  terminateSpawn: mockTerminateSpawn,
} as unknown as import('../src/coordinator-client.js').CoordinatorClient;

const { CoordinatorSpawnBackend } =
  await import('../src/coordinator-spawn-backend.js');

describe('CoordinatorSpawnBackend', () => {
  let backend: InstanceType<typeof CoordinatorSpawnBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new CoordinatorSpawnBackend(mockClient);
  });

  describe('spawnSession', () => {
    it('spawns on the supplied beacon and returns a SpawnSession', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });

      const session = await backend.spawnSession('conv-1', 'coder', {
        targetBeaconId: 'beacon-1',
      });

      expect(mockSpawnAgent).toHaveBeenCalledWith({
        targetBeaconId: 'beacon-1',
        personaId: 'coder',
        spawnId: expect.any(String),
      });
      expect(session.conversationId).toBe('conv-1');
      expect(session.personaId).toBe('coder');
      expect(session.processId).toBe('agent-xyz');
      expect(session.spawnId).toBe('spawn-abc');
      expect(session.startedAt).toBeGreaterThan(0);
      expect(session.targetBeaconId).toBe('beacon-1');
    });

    it('throws when no target beacon is supplied', async () => {
      await expect(backend.spawnSession('conv-1', 'coder')).rejects.toThrow(
        /requires a targetBeaconId/
      );
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('returns existing session for same conversationId (idempotent)', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });

      const session1 = await backend.spawnSession('conv-1', 'coder', {
        targetBeaconId: 'beacon-1',
      });
      const session2 = await backend.spawnSession('conv-1', 'coder', {
        targetBeaconId: 'beacon-2',
      });

      expect(session2).toBe(session1);
      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    });

    it('uses spawnId from response when agentId is not present', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        status: 'running',
      });

      const session = await backend.spawnSession('conv-1', 'coder', {
        targetBeaconId: 'beacon-1',
      });

      expect(session.processId).toBe('spawn-abc');
    });

    it('forwards workingDir as config.workingDir', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });

      const session = await backend.spawnSession('conv-1', 'coder', {
        targetBeaconId: 'beacon-1',
        workingDir: '/srv/bots/coder',
      });

      expect(mockSpawnAgent).toHaveBeenCalledWith({
        targetBeaconId: 'beacon-1',
        personaId: 'coder',
        spawnId: expect.any(String),
        config: { workingDir: '/srv/bots/coder' },
      });
      expect(session.workingDir).toBe('/srv/bots/coder');
    });

    it('omits config when no workingDir is supplied', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });

      await backend.spawnSession('conv-1', 'coder', {
        targetBeaconId: 'beacon-1',
      });

      expect(mockSpawnAgent).toHaveBeenCalledWith({
        targetBeaconId: 'beacon-1',
        personaId: 'coder',
        spawnId: expect.any(String),
      });
    });

    it('dedupes concurrent spawns for the same conversation', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });

      const [a, b] = await Promise.all([
        backend.spawnSession('conv-1', 'coder', { targetBeaconId: 'beacon-1' }),
        backend.spawnSession('conv-1', 'coder', { targetBeaconId: 'beacon-1' }),
      ]);

      expect(a).toBe(b);
      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendMessage', () => {
    it('delivers via sendSessionMessage and returns null (no synchronous reply)', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });
      mockSendSessionMessage.mockResolvedValue({
        success: true,
        delivered: true,
      });
      const session = await backend.spawnSession('conv-1', 'coder', {
        targetBeaconId: 'beacon-1',
      });
      const response = await backend.sendMessage(session, 'Hi there');
      expect(mockSendSessionMessage).toHaveBeenCalledWith(
        'agent-xyz',
        'Hi there',
        false
      );
      expect(response).toBeNull();
    });
  });

  describe('terminateSession', () => {
    it("targets the session's own beacon and removes the session", async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });
      mockTerminateSpawn.mockResolvedValue({ status: 'terminated' });

      const session = await backend.spawnSession('conv-1', 'coder', {
        targetBeaconId: 'beacon-2',
      });
      await backend.terminateSession(session);

      // The terminate endpoint is keyed on the beacon's spawnId, not the
      // agentId (which is what processId holds for message relay).
      expect(mockTerminateSpawn).toHaveBeenCalledWith('beacon-2', 'spawn-abc');
    });

    it('warns and skips the network call when the session has no beacon', async () => {
      const session = {
        conversationId: 'conv-1',
        personaId: 'coder',
        processId: 'agent-xyz',
        startedAt: 0,
      };

      await expect(backend.terminateSession(session)).resolves.toBeUndefined();
      expect(mockTerminateSpawn).not.toHaveBeenCalled();
    });

    it('warns and skips the network call when the session has no spawn id', async () => {
      const session = {
        conversationId: 'conv-1',
        personaId: 'coder',
        processId: 'agent-xyz',
        startedAt: 0,
        targetBeaconId: 'beacon-1',
      };

      await expect(backend.terminateSession(session)).resolves.toBeUndefined();
      expect(mockTerminateSpawn).not.toHaveBeenCalled();
    });

    it('warns on failure but does not throw', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });
      mockTerminateSpawn.mockRejectedValue(new Error('Network error'));

      const session = await backend.spawnSession('conv-1', 'coder', {
        targetBeaconId: 'beacon-1',
      });

      await expect(backend.terminateSession(session)).resolves.toBeUndefined();
    });
  });
});

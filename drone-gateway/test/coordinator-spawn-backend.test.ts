import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock CoordinatorClient at module level since CoordinatorSpawnBackend
// creates its own instance internally
const mockSpawnAgent = vi.fn();
const mockSendMessage = vi.fn();
const mockTerminateSpawn = vi.fn();

vi.mock('../src/coordinator-client.js', () => ({
  CoordinatorClient: vi.fn().mockImplementation(() => ({
    spawnAgent: mockSpawnAgent,
    sendMessage: mockSendMessage,
    terminateSpawn: mockTerminateSpawn,
  })),
}));

const { CoordinatorSpawnBackend } = await import(
  '../src/coordinator-spawn-backend.js'
);

describe('CoordinatorSpawnBackend', () => {
  let backend: CoordinatorSpawnBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new CoordinatorSpawnBackend(
      'http://localhost:8080',
      'my-token',
      'beacon-1'
    );
  });

  describe('spawnSession', () => {
    it('calls coordinatorClient.spawnAgent and returns a SpawnSession', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });

      const session = await backend.spawnSession('conv-1', 'coder');

      expect(mockSpawnAgent).toHaveBeenCalledWith('beacon-1', {
        personaId: 'coder',
        spawnId: expect.any(String),
      });
      expect(session.conversationId).toBe('conv-1');
      expect(session.personaId).toBe('coder');
      expect(session.processId).toBe('agent-xyz');
      expect(session.startedAt).toBeGreaterThan(0);
    });

    it('returns existing session for same conversationId (idempotent)', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });

      const session1 = await backend.spawnSession('conv-1', 'coder');
      const session2 = await backend.spawnSession('conv-1', 'coder');

      expect(session2).toBe(session1);
      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    });

    it('uses spawnId from response when agentId is not present', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        status: 'running',
      });

      const session = await backend.spawnSession('conv-1', 'coder');

      expect(session.processId).toBe('spawn-abc');
    });
  });

  describe('sendMessage', () => {
    it('calls coordinatorClient.sendMessage with correct agentId and message', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });
      mockSendMessage.mockResolvedValue('Hello back!');

      const session = await backend.spawnSession('conv-1', 'coder');
      const response = await backend.sendMessage(session, 'Hi there');

      expect(mockSendMessage).toHaveBeenCalledWith('agent-xyz', 'Hi there');
      expect(response).toBe('Hello back!');
    });
  });

  describe('terminateSession', () => {
    it('calls coordinatorClient.terminateSpawn and removes session', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });
      mockTerminateSpawn.mockResolvedValue({ status: 'terminated' });

      const session = await backend.spawnSession('conv-1', 'coder');
      await backend.terminateSession(session);

      expect(mockTerminateSpawn).toHaveBeenCalledWith(
        'beacon-1',
        'agent-xyz'
      );
    });

    it('warns on failure but does not throw', async () => {
      mockSpawnAgent.mockResolvedValue({
        spawnId: 'spawn-abc',
        agentId: 'agent-xyz',
        status: 'running',
      });
      mockTerminateSpawn.mockRejectedValue(new Error('Network error'));

      const session = await backend.spawnSession('conv-1', 'coder');

      // Should not throw
      await expect(
        backend.terminateSession(session)
      ).resolves.toBeUndefined();
    });
  });
});

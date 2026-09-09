import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/spawner.js', () => ({
  spawnAgent: vi.fn(),
  terminateAgent: vi.fn(),
}));

vi.mock('../src/spawn-roots.js', () => ({
  getDefaultSpawnRoot: vi.fn(),
  getSpawnRoots: vi.fn(),
  isSpawnRootAllowed: vi.fn(),
}));

vi.mock('../src/db/index.js', () => ({
  getPersona: vi.fn(),
  createSpawn: vi.fn(),
  updateSpawnStatus: vi.fn(),
}));

vi.mock('../src/routes/context.js', () => ({
  getBeaconUrl: vi.fn(() => 'http://localhost:3457'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handleSpawnAgent } = await import('../src/routes/spawn-handlers.js');
const spawner = await import('../src/spawner.js');
const spawnRoots = await import('../src/spawn-roots.js');

describe('handleSpawnAgent spawnRoots enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spawner.spawnAgent).mockResolvedValue({
      id: 'spawn-1',
      agentId: 'agent-1',
      personaId: null,
      task: null,
      configJson: null,
      status: 'spawning',
      error: null,
      createdAt: 0,
      startedAt: null,
      terminatedAt: null,
      exitCode: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a workingDir outside the whitelist with a 400', async () => {
    vi.mocked(spawnRoots.isSpawnRootAllowed).mockReturnValue(false);
    vi.mocked(spawnRoots.getSpawnRoots).mockReturnValue(['/allowed']);

    const result = await handleSpawnAgent({
      config: { workingDir: '/not-allowed' },
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toContain('not in the spawnRoots whitelist');
    expect(spawner.spawnAgent).not.toHaveBeenCalled();
  });

  it('accepts a workingDir within the whitelist', async () => {
    vi.mocked(spawnRoots.isSpawnRootAllowed).mockReturnValue(true);

    const result = await handleSpawnAgent({
      config: { workingDir: '/allowed' },
    });

    expect(result.status).toBe(202);
    expect(spawner.spawnAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      null,
      null,
      { workingDir: '/allowed' }
    );
  });

  it('defaults to the configured default root when workingDir is omitted', async () => {
    vi.mocked(spawnRoots.getDefaultSpawnRoot).mockReturnValue('/default-root');

    const result = await handleSpawnAgent({});

    expect(result.status).toBe(202);
    expect(spawner.spawnAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      null,
      null,
      { workingDir: '/default-root' }
    );
  });
});

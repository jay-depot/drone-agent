import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSwarmPlugin } from '../src/plugins/swarm/index.js';
import { silentLogger } from './helpers.js';
import { createDefaultAgentConfig, toToolResultContent } from 'drone-core';
import type { DronePluginRegistration, DroneToolDefinition } from 'drone-core';

/**
 * Helper: creates a mock fetch that handles the beacon registration call
 * (which happens during plugin registration) and then delegates to a
 * per-test handler for subsequent calls.
 */
function mockFetchWithBeaconRegistration(
  handler: (url: string, options?: RequestInit) => unknown
) {
  return vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    // Beacon registration call — must succeed for plugin to load
    if (url === 'http://localhost:3457/agents' && options?.method === 'POST') {
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }
    return handler(url, options);
  });
}

/**
 * Creates a registration capture that records registered tools.
 */
function createRegistrationCapture(
  config: ReturnType<typeof createDefaultAgentConfig>
) {
  const registeredTools = new Map<string, DroneToolDefinition>();

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => config,
    registerTool: (tool: DroneToolDefinition) => {
      registeredTools.set(tool.name, tool);
    },
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: () => undefined,
    runWorkflow: async () => ({ toolResult: undefined }),
    requestElicitation: () => undefined,
  };

  return { registration, registeredTools };
}

/** Default agent config without any coordinatorUrl (it no longer exists). */
function defaultConfig() {
  return createDefaultAgentConfig({});
}

/** The beacon base URL the swarm plugin connects to by default. */
const BEACON_BASE = 'http://localhost:3457';

describe('swarm spawn tools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers all 13 swarm tools at init', async () => {
    const mockFetch = mockFetchWithBeaconRegistration(() =>
      Promise.resolve({ ok: true, json: async () => [] })
    );
    vi.stubGlobal('fetch', mockFetch);

    const { registration, registeredTools } =
      createRegistrationCapture(defaultConfig());
    const plugin = createSwarmPlugin({});
    await plugin.register(registration);

    const expected = [
      'swarm_message',
      'wiki_read',
      'wiki_write',
      'wiki_search',
      'wiki_list',
      'wiki_delete',
      'wiki_lint',
      'swarm_list_beacons',
      'swarm_list_agents',
      'swarm_spawn',
      'swarm_get_spawn',
      'swarm_list_spawns',
      'swarm_terminate_spawn',
    ];
    for (const name of expected) {
      expect(registeredTools.has(name), `missing tool: ${name}`).toBe(true);
    }
    expect(registeredTools.size).toBe(13);
  });

  describe('swarm_list_beacons', () => {
    it('returns list of beacons from the beacon proxy', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({
          ok: true,
          json: async () => [
            { id: 'b1', name: 'Beacon 1', host: 'localhost', port: 3457 },
          ],
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_list_beacons')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({});
      const parsed = JSON.parse(toToolResultContent(result));
      expect(parsed.success).toBe(true);
      expect(parsed[0].id).toBe('b1');
    });

    it('hits the beacon /coordinator/beacons route', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: true, json: async () => [] })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_list_beacons')!;
      await tool.execute({});
      expect(mockFetch).toHaveBeenCalledWith(
        `${BEACON_BASE}/coordinator/beacons`,
        expect.any(Object)
      );
    });

    it('returns error when the beacon proxy returns 503 (coordinator unavailable)', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_list_beacons')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({});
      const parsed = JSON.parse(toToolResultContent(result));
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Coordinator proxy returned 503');
    });

    it('returns error when the beacon is unreachable', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.reject(new Error('Connection refused'))
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_list_beacons')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({});
      const parsed = JSON.parse(toToolResultContent(result));
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Failed to reach coordinator');
    });
  });

  describe('swarm_list_agents', () => {
    it('returns list of agent locations', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({
          ok: true,
          json: async () => [
            { agentId: 'a1', beaconId: 'b1', personaId: 'coder' },
          ],
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_list_agents')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({});
      const parsed = JSON.parse(toToolResultContent(result));
      expect(parsed.success).toBe(true);
      expect(parsed[0].agentId).toBe('a1');
    });

    it('passes beaconId filter to the beacon proxy', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: true, json: async () => [] })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_list_agents')!;
      expect(tool).toBeDefined();
      await tool.execute({ beaconId: 'b1' });
      expect(mockFetch).toHaveBeenCalledWith(
        `${BEACON_BASE}/coordinator/agents/location?beaconId=b1`,
        expect.any(Object)
      );
    });
  });

  describe('swarm_spawn', () => {
    it('spawns an agent on a target beacon via the proxy', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            spawnId: 'spawn-123',
            agentId: 'agent-abc',
            status: 'spawning',
            targetBeaconId: 'b-target',
          }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_spawn')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({
        targetBeaconId: 'b-target',
        personaId: 'coder',
        task: 'fix bugs',
      });
      const parsed = JSON.parse(toToolResultContent(result));
      expect(parsed.success).toBe(true);
      expect(parsed.spawnId).toBe('spawn-123');
      expect(parsed.status).toBe('spawning');
    });

    it('posts to the beacon /coordinator/spawn route', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: true, json: async () => ({}) })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_spawn')!;
      await tool.execute({ targetBeaconId: 'b-target' });
      expect(mockFetch).toHaveBeenCalledWith(
        `${BEACON_BASE}/coordinator/spawn`,
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('returns error when the beacon proxy returns 503', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_spawn')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({ targetBeaconId: 'b-target' });
      const parsed = JSON.parse(toToolResultContent(result));
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Coordinator proxy returned 503');
    });
  });

  describe('swarm_get_spawn', () => {
    it('returns spawn status from the proxy', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            spawnId: 's1',
            agentId: 'agent-abc',
            status: 'running',
          }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_get_spawn')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({ beaconId: 'b1', spawnId: 's1' });
      const parsed = JSON.parse(toToolResultContent(result));
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe('running');
    });
  });

  describe('swarm_list_spawns', () => {
    it('lists spawns on a beacon', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({
          ok: true,
          json: async () => [{ id: 's1', status: 'running' }],
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_list_spawns')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({ beaconId: 'b1' });
      const parsed = JSON.parse(toToolResultContent(result));
      expect(parsed.success).toBe(true);
      expect(parsed[0].id).toBe('s1');
    });

    it('passes status filter to the beacon proxy', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: true, json: async () => [] })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_list_spawns')!;
      expect(tool).toBeDefined();
      await tool.execute({ beaconId: 'b1', status: 'running' });
      expect(mockFetch).toHaveBeenCalledWith(
        `${BEACON_BASE}/coordinator/spawn/b1?status=running`,
        expect.any(Object)
      );
    });
  });

  describe('swarm_terminate_spawn', () => {
    it('terminates a spawned agent', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            message: 'Termination signal sent',
          }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_terminate_spawn')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({ beaconId: 'b1', spawnId: 's1' });
      const parsed = JSON.parse(toToolResultContent(result));
      expect(parsed.success).toBe(true);
    });

    it('sends DELETE request to the beacon proxy', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: true, json: async () => ({ success: true }) })
      );
      vi.stubGlobal('fetch', mockFetch);

      const { registration, registeredTools } =
        createRegistrationCapture(defaultConfig());
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const tool = registeredTools.get('swarm_terminate_spawn')!;
      expect(tool).toBeDefined();
      await tool.execute({ beaconId: 'b1', spawnId: 's1' });
      expect(mockFetch).toHaveBeenCalledWith(
        `${BEACON_BASE}/coordinator/spawn/b1/s1`,
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});

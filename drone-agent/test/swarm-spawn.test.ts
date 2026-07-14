import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSwarmPlugin } from '../src/plugins/swarm/index.js';
import { silentLogger } from './helpers.js';
import { createDefaultAgentConfig } from 'drone-core';
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

describe('swarm spawn tools (list/mount pattern)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers only 3 meta-tools at init', async () => {
    const mockFetch = mockFetchWithBeaconRegistration(() =>
      Promise.resolve({ ok: true, json: async () => [] })
    );
    vi.stubGlobal('fetch', mockFetch);

    const config = createDefaultAgentConfig({
      swarm: { coordinatorUrl: 'http://localhost:3456' },
    });
    const { registration, registeredTools } = createRegistrationCapture(config);
    const plugin = createSwarmPlugin({
      coordinatorUrl: 'http://localhost:3456',
    });
    await plugin.register(registration);

    expect(registeredTools.has('list_tools')).toBe(true);
    expect(registeredTools.has('mount_tool')).toBe(true);
    expect(registeredTools.has('unmount_tool')).toBe(true);
    expect(registeredTools.size).toBe(3);
  });

  it('list_tools returns all 13 tool descriptions', async () => {
    const mockFetch = mockFetchWithBeaconRegistration(() =>
      Promise.resolve({ ok: true, json: async () => [] })
    );
    vi.stubGlobal('fetch', mockFetch);

    const config = createDefaultAgentConfig({
      swarm: { coordinatorUrl: 'http://localhost:3456' },
    });
    const { registration, registeredTools } = createRegistrationCapture(config);
    const plugin = createSwarmPlugin({
      coordinatorUrl: 'http://localhost:3456',
    });
    await plugin.register(registration);

    const result = JSON.parse(
      await registeredTools.get('list_tools')!.execute({})
    );
    expect(result.toolCount).toBe(13);
    const names = result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('swarm_message');
    expect(names).toContain('wiki_read');
    expect(names).toContain('wiki_write');
    expect(names).toContain('wiki_search');
    expect(names).toContain('wiki_list');
    expect(names).toContain('wiki_delete');
    expect(names).toContain('wiki_lint');
    expect(names).toContain('swarm_list_beacons');
    expect(names).toContain('swarm_list_agents');
    expect(names).toContain('swarm_spawn');
    expect(names).toContain('swarm_get_spawn');
    expect(names).toContain('swarm_list_spawns');
    expect(names).toContain('swarm_terminate_spawn');
  });

  it('mount_tool mounts a tool and it becomes callable', async () => {
    const mockFetch = mockFetchWithBeaconRegistration(() =>
      Promise.resolve({
        ok: true,
        json: async () => [
          { id: 'b1', name: 'Beacon 1', host: 'localhost', port: 3457 },
        ],
      })
    );
    vi.stubGlobal('fetch', mockFetch);

    const config = createDefaultAgentConfig({
      swarm: { coordinatorUrl: 'http://localhost:3456' },
    });
    const { registration, registeredTools } = createRegistrationCapture(config);
    const plugin = createSwarmPlugin({
      coordinatorUrl: 'http://localhost:3456',
    });
    await plugin.register(registration);

    // Mount the tool
    const mountResult = JSON.parse(
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_list_beacons' })
    );
    expect(mountResult.success).toBe(true);
    expect(mountResult.tool).toBe('swarm_list_beacons');

    // Now it should be registered
    expect(registeredTools.has('swarm_list_beacons')).toBe(true);

    // Call the mounted tool
    const result = await registeredTools.get('swarm_list_beacons')!.execute({});
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed[0].id).toBe('b1');
  });

  it('mount_tool rejects an unknown tool name', async () => {
    const mockFetch = mockFetchWithBeaconRegistration(() =>
      Promise.resolve({ ok: true, json: async () => [] })
    );
    vi.stubGlobal('fetch', mockFetch);

    const config = createDefaultAgentConfig({
      swarm: { coordinatorUrl: 'http://localhost:3456' },
    });
    const { registration, registeredTools } = createRegistrationCapture(config);
    const plugin = createSwarmPlugin({
      coordinatorUrl: 'http://localhost:3456',
    });
    await plugin.register(registration);

    const result = JSON.parse(
      await registeredTools.get('mount_tool')!.execute({ tool: 'nonexistent' })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('nonexistent');
  });

  it('unmount_tool removes a mounted tool', async () => {
    const mockFetch = mockFetchWithBeaconRegistration(() =>
      Promise.resolve({ ok: true, json: async () => [] })
    );
    vi.stubGlobal('fetch', mockFetch);

    const config = createDefaultAgentConfig({
      swarm: { coordinatorUrl: 'http://localhost:3456' },
    });
    const { registration, registeredTools } = createRegistrationCapture(config);
    const plugin = createSwarmPlugin({
      coordinatorUrl: 'http://localhost:3456',
    });
    await plugin.register(registration);

    // Mount first
    await registeredTools
      .get('mount_tool')!
      .execute({ tool: 'swarm_list_beacons' });
    expect(registeredTools.has('swarm_list_beacons')).toBe(true);

    // Unmount
    const unmountResult = JSON.parse(
      await registeredTools
        .get('unmount_tool')!
        .execute({ tool: 'swarm_list_beacons' })
    );
    expect(unmountResult.success).toBe(true);
    expect(unmountResult.tool).toBe('swarm_list_beacons');
  });

  describe('swarm_list_beacons', () => {
    it('returns list of beacons from coordinator', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({
          ok: true,
          json: async () => [
            { id: 'b1', name: 'Beacon 1', host: 'localhost', port: 3457 },
          ],
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const config = createDefaultAgentConfig({
        swarm: { coordinatorUrl: 'http://localhost:3456' },
      });
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({
        coordinatorUrl: 'http://localhost:3456',
      });
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_list_beacons' });

      const tool = registeredTools.get('swarm_list_beacons')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed[0].id).toBe('b1');
    });

    it('returns error when coordinatorUrl not configured', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: true, json: async () => [] })
      );
      vi.stubGlobal('fetch', mockFetch);

      const config = createDefaultAgentConfig({});
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_list_beacons' });

      const tool = registeredTools.get('swarm_list_beacons')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.details.error).toContain('coordinatorUrl');
    });

    it('returns error when coordinator is unreachable', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.reject(new Error('Connection refused'))
      );
      vi.stubGlobal('fetch', mockFetch);

      const config = createDefaultAgentConfig({
        swarm: { coordinatorUrl: 'http://localhost:3456' },
      });
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({
        coordinatorUrl: 'http://localhost:3456',
      });
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_list_beacons' });

      const tool = registeredTools.get('swarm_list_beacons')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({});
      const parsed = JSON.parse(result);
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

      const config = createDefaultAgentConfig({
        swarm: { coordinatorUrl: 'http://localhost:3456' },
      });
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({
        coordinatorUrl: 'http://localhost:3456',
      });
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_list_agents' });

      const tool = registeredTools.get('swarm_list_agents')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed[0].agentId).toBe('a1');
    });

    it('passes beaconId filter to coordinator', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: true, json: async () => [] })
      );
      vi.stubGlobal('fetch', mockFetch);

      const config = createDefaultAgentConfig({
        swarm: { coordinatorUrl: 'http://localhost:3456' },
      });
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({
        coordinatorUrl: 'http://localhost:3456',
      });
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_list_agents' });

      const tool = registeredTools.get('swarm_list_agents')!;
      expect(tool).toBeDefined();
      await tool.execute({ beaconId: 'b1' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3456/agents/location?beaconId=b1',
        expect.any(Object)
      );
    });
  });

  describe('swarm_spawn', () => {
    it('spawns an agent on a target beacon', async () => {
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

      const config = createDefaultAgentConfig({
        swarm: { coordinatorUrl: 'http://localhost:3456' },
      });
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({
        coordinatorUrl: 'http://localhost:3456',
      });
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools.get('mount_tool')!.execute({ tool: 'swarm_spawn' });

      const tool = registeredTools.get('swarm_spawn')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({
        targetBeaconId: 'b-target',
        personaId: 'coder',
        task: 'fix bugs',
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.spawnId).toBe('spawn-123');
      expect(parsed.status).toBe('spawning');
    });

    it('returns error when coordinatorUrl not configured', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: true, json: async () => ({}) })
      );
      vi.stubGlobal('fetch', mockFetch);

      const config = createDefaultAgentConfig({});
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools.get('mount_tool')!.execute({ tool: 'swarm_spawn' });

      const tool = registeredTools.get('swarm_spawn')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({ targetBeaconId: 'b-target' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.details.error).toContain('coordinatorUrl');
    });
  });

  describe('swarm_get_spawn', () => {
    it('returns spawn status from beacon', async () => {
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

      const config = createDefaultAgentConfig({
        swarm: { coordinatorUrl: 'http://localhost:3456' },
      });
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({
        coordinatorUrl: 'http://localhost:3456',
      });
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_get_spawn' });

      const tool = registeredTools.get('swarm_get_spawn')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({ beaconId: 'b1', spawnId: 's1' });
      const parsed = JSON.parse(result);
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

      const config = createDefaultAgentConfig({
        swarm: { coordinatorUrl: 'http://localhost:3456' },
      });
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({
        coordinatorUrl: 'http://localhost:3456',
      });
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_list_spawns' });

      const tool = registeredTools.get('swarm_list_spawns')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({ beaconId: 'b1' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed[0].id).toBe('s1');
    });

    it('passes status filter to coordinator', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: true, json: async () => [] })
      );
      vi.stubGlobal('fetch', mockFetch);

      const config = createDefaultAgentConfig({
        swarm: { coordinatorUrl: 'http://localhost:3456' },
      });
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({
        coordinatorUrl: 'http://localhost:3456',
      });
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_list_spawns' });

      const tool = registeredTools.get('swarm_list_spawns')!;
      expect(tool).toBeDefined();
      await tool.execute({ beaconId: 'b1', status: 'running' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3456/spawn/b1?status=running',
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

      const config = createDefaultAgentConfig({
        swarm: { coordinatorUrl: 'http://localhost:3456' },
      });
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({
        coordinatorUrl: 'http://localhost:3456',
      });
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_terminate_spawn' });

      const tool = registeredTools.get('swarm_terminate_spawn')!;
      expect(tool).toBeDefined();
      const result = await tool.execute({ beaconId: 'b1', spawnId: 's1' });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
    });

    it('sends DELETE request to coordinator', async () => {
      const mockFetch = mockFetchWithBeaconRegistration(() =>
        Promise.resolve({ ok: true, json: async () => ({ success: true }) })
      );
      vi.stubGlobal('fetch', mockFetch);

      const config = createDefaultAgentConfig({
        swarm: { coordinatorUrl: 'http://localhost:3456' },
      });
      const { registration, registeredTools } =
        createRegistrationCapture(config);
      const plugin = createSwarmPlugin({
        coordinatorUrl: 'http://localhost:3456',
      });
      await plugin.register(registration);

      // Mount the tool first
      await registeredTools
        .get('mount_tool')!
        .execute({ tool: 'swarm_terminate_spawn' });

      const tool = registeredTools.get('swarm_terminate_spawn')!;
      expect(tool).toBeDefined();
      await tool.execute({ beaconId: 'b1', spawnId: 's1' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3456/spawn/b1/s1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});

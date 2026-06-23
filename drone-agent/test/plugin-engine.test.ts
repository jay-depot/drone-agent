import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultAgentConfig,
  type DronePlugin,
  type DroneSessionSafetyTrimPayload,
  type DroneToolDefinition,
} from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { createTestPlugin, silentLogger } from './helpers.js';

describe('createDronePluginEngine', () => {
  it('registers plugins, exposes tools, and runs hooks in order', async () => {
    const calls: string[] = [];

    const plugins: DronePlugin[] = [
      createTestPlugin({
        id: 'a',
        hooks: {
          onPluginsLoaded: async () => {
            calls.push('a:loaded');
          },
          onSessionStart: async () => {
            calls.push('a:start');
          },
        },
      }),
      createTestPlugin({
        id: 'b',
        hooks: {
          onSessionStart: async () => {
            calls.push('b:start');
          },
          onBeforePrompt: async () => {
            calls.push('b:before');
          },
        },
      }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });

    await engine.initialize();
    await engine.runHooks('onPluginsLoaded');
    await engine.runHooks('onSessionStart');
    await engine.runHooks('onBeforePrompt');

    // Plugin B has no onPluginsLoaded hook, so only A fires.
    expect(calls).toEqual(['a:loaded', 'a:start', 'b:start', 'b:before']);
  });

  it('respects explicit enabledPlugins from config', async () => {
    const plugins: DronePlugin[] = [
      createTestPlugin({ id: 'opt-in', defaultEnabled: false }),
      createTestPlugin({ id: 'always', defaultEnabled: true }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: { ...createDefaultAgentConfig(), enabledPlugins: ['opt-in'] },
      logger: silentLogger(),
    });

    await engine.initialize();
    const statuses = engine.listPlugins();
    expect(statuses.find(p => p.id === 'opt-in')?.enabled).toBe(true);
    expect(statuses.find(p => p.id === 'always')?.enabled).toBe(false);
  });

  it('always enables required plugins even when not in enabledPlugins', async () => {
    const plugins: DronePlugin[] = [
      createTestPlugin({ id: 'required', required: true }),
      createTestPlugin({ id: 'optional' }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: {
        ...createDefaultAgentConfig(),
        enabledPlugins: ['optional'],
      },
      logger: silentLogger(),
    });

    await engine.initialize();
    const statuses = engine.listPlugins();
    expect(statuses.find(p => p.id === 'required')?.enabled).toBe(true);
    expect(statuses.find(p => p.id === 'optional')?.enabled).toBe(true);
  });

  it('enables default-enabled plugins when no enabledPlugins is set', async () => {
    const plugins: DronePlugin[] = [
      createTestPlugin({ id: 'on-by-default', defaultEnabled: true }),
      createTestPlugin({ id: 'opt-in', defaultEnabled: false }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });

    await engine.initialize();
    const statuses = engine.listPlugins();
    expect(statuses.find(p => p.id === 'on-by-default')?.enabled).toBe(true);
    expect(statuses.find(p => p.id === 'opt-in')?.enabled).toBe(false);
  });

  it('throws on duplicate plugin ids', () => {
    const plugins: DronePlugin[] = [
      createTestPlugin({ id: 'dup' }),
      createTestPlugin({ id: 'dup' }),
    ];

    expect(() =>
      createDronePluginEngine({
        plugins,
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      })
    ).toThrow(/Duplicate plugin id/);
  });

  it('throws when enabledPlugins references an unknown plugin', () => {
    const plugins: DronePlugin[] = [createTestPlugin({ id: 'known' })];
    expect(() =>
      createDronePluginEngine({
        plugins,
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['unknown'],
        },
        logger: silentLogger(),
      })
    ).toThrow(/Config enabled unknown plugin/);
  });

  it('throws on plugin dependency cycles', () => {
    const plugins: DronePlugin[] = [
      createTestPlugin({
        id: 'a',
        dependencies: [{ id: 'b' }],
      }),
      createTestPlugin({
        id: 'b',
        dependencies: [{ id: 'a' }],
      }),
    ];

    expect(() =>
      createDronePluginEngine({
        plugins,
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      })
    ).toThrow(/Plugin dependency cycle/);
  });

  it('throws when a plugin depends on a missing or disabled plugin', () => {
    const plugins: DronePlugin[] = [
      createTestPlugin({
        id: 'a',
        dependencies: [{ id: 'missing' }],
      }),
    ];

    expect(() =>
      createDronePluginEngine({
        plugins,
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      })
    ).toThrow(/missing or disabled dependency/);
  });

  it('exposes canonical tool names and routes executeTool', async () => {
    const tool: DroneToolDefinition = {
      name: 'echo',
      description: 'echoes input',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
      },
      execute: async input => `echo:${(input as { message: string }).message}`,
    };

    const plugins: DronePlugin[] = [
      createTestPlugin({
        id: 'echo-plugin',
        tools: [tool],
      }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();

    const tools = engine.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('echo-plugin.echo');
    expect(engine.getTool('echo-plugin.echo')).toBeDefined();
    expect(engine.getTool('missing')).toBeUndefined();

    const output = await engine.executeTool('echo-plugin.echo', {
      message: 'hi',
    });
    expect(output).toBe('echo:hi');

    await expect(engine.executeTool('missing.tool', {})).rejects.toThrow(
      /Unknown tool/
    );
  });

  it('throws when registering two tools with the same canonical name', async () => {
    // Two different tools with the same raw name inside a single plugin
    // will both produce the canonical name `<pluginId>.<name>`.
    const toolA: DroneToolDefinition = {
      name: 'shared',
      description: 'first',
      execute: async () => 'first',
    };
    const toolB: DroneToolDefinition = {
      name: 'shared',
      description: 'second',
      execute: async () => 'second',
    };

    const engine = createDronePluginEngine({
      plugins: [
        createTestPlugin({
          id: 'p1',
          register: ({ registerTool }) => {
            registerTool(toolA);
            registerTool(toolB);
          },
        }),
      ],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });

    await expect(engine.initialize()).rejects.toThrow(
      /Tool already registered/
    );
  });

  it('renders prompt fragments and filters empty/false values', async () => {
    const plugins: DronePlugin[] = [
      createTestPlugin({
        id: 'frag',
        prompts: [
          {
            key: 'a',
            phase: 'header',
            render: async () => 'hello',
          },
          {
            key: 'b',
            phase: 'header',
            render: async () => '',
          },
          {
            key: 'c',
            phase: 'footer',
            render: async () => false,
          },
          {
            key: 'd',
            phase: 'footer',
            render: async () => 'goodbye',
          },
        ],
      }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();
    const rendered = await engine.renderPromptFragments();
    expect(rendered).toEqual(['hello', 'goodbye']);
  });

  it('throws when a plugin registers two prompt fragments with the same key', async () => {
    const plugins: DronePlugin[] = [
      createTestPlugin({
        id: 'frag',
        prompts: [
          { key: 'same', phase: 'header', render: async () => 'one' },
          { key: 'same', phase: 'header', render: async () => 'two' },
        ],
      }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await expect(engine.initialize()).rejects.toThrow(
      /Prompt fragment already registered/
    );
  });

  it('rejects requests for capabilities that are not declared dependencies', async () => {
    let requestError: unknown = null;
    const plugins: DronePlugin[] = [
      createTestPlugin({
        id: 'consumer',
        register: ({ request }) => {
          try {
            request('other');
          } catch (err) {
            requestError = err;
          }
        },
      }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();
    expect((requestError as Error).message).toMatch(/undeclared capability/);
  });

  it('allows plugins to request declared capabilities', async () => {
    const provider = { provider: 'fake' };
    let received: unknown;

    const plugins: DronePlugin[] = [
      createTestPlugin({
        id: 'producer',
        capability: provider,
      }),
      createTestPlugin({
        id: 'consumer',
        dependencies: [{ id: 'producer' }],
        register: ({ request }) => {
          received = request<typeof provider>('producer');
        },
      }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();
    expect(received).toBe(provider);
    expect(engine.getCapability('producer')).toBe(provider);
    expect(engine.getCapability('consumer')).toBeUndefined();
  });

  it('returns help snippets only from enabled plugins', async () => {
    const plugins: DronePlugin[] = [
      createTestPlugin({ id: 'shown', help: ['help-from-shown'] }),
      createTestPlugin({
        id: 'hidden',
        defaultEnabled: false,
        help: ['help-from-hidden'],
      }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();
    expect(engine.getHelpSnippets()).toEqual(['help-from-shown']);
  });

  it('runs safety-trim hooks with payloads and the engine forwards mutated payloads', async () => {
    const willRun = vi.fn(async (payload: DroneSessionSafetyTrimPayload) => {
      payload.proposedDropTurnCount = payload.proposedDropTurnCount + 1;
    });
    const applied = vi.fn(async () => {
      // assertion-only spy
    });

    const plugins: DronePlugin[] = [
      createTestPlugin({
        id: 'observer',
        hooks: {
          onSessionSafetyTrimWillRun: willRun,
          onSessionSafetyTrimApplied: applied,
        },
      }),
    ];

    const engine = createDronePluginEngine({
      plugins,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();

    const payload: DroneSessionSafetyTrimPayload = {
      model: 'test',
      contextWindow: {
        model: 'test',
        contextWindowTokens: 1024,
        source: 'config',
      },
      budget: {
        estimatedSystemTokens: 0,
        estimatedSessionTokens: 0,
        estimatedToolTokens: 0,
        estimatedPromptTokens: 0,
        reservedResponseTokens: 0,
        estimatedTotalTokens: 0,
        contextWindowTokens: 1024,
        maxPromptTokens: 1024,
        requiresSafetyTrim: true,
      },
      currentTurns: [],
      proposedDropTurnCount: 1,
    };

    await engine.runSessionSafetyTrimWillRunHooks(payload);
    await engine.runSessionSafetyTrimAppliedHooks(payload);

    expect(willRun).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledTimes(1);
    // The willRun hook mutated the payload, and the engine forwards it.
    expect(payload.proposedDropTurnCount).toBe(2);
  });

  describe('enablePlugin', () => {
    it('enables a default-disabled plugin and makes its tools available', async () => {
      const tool: DroneToolDefinition = {
        name: 'ping',
        description: 'ping tool',
        inputSchema: { type: 'object', additionalProperties: false },
        execute: async () => 'pong',
      };

      const plugins: DronePlugin[] = [
        createTestPlugin({
          id: 'bootstrap',
          defaultEnabled: false,
          tools: [tool],
        }),
      ];

      const engine = createDronePluginEngine({
        plugins,
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      // Not enabled initially
      expect(engine.getTool('bootstrap.ping')).toBeUndefined();
      expect(engine.listPlugins().find(p => p.id === 'bootstrap')?.enabled).toBe(false);

      // Enable it
      const result = await engine.enablePlugin('bootstrap');
      expect(result).toBe(true);
      expect(engine.getTool('bootstrap.ping')).toBeDefined();
      expect(engine.listPlugins().find(p => p.id === 'bootstrap')?.enabled).toBe(true);

      // Tool is callable
      const output = await engine.executeTool('bootstrap.ping', {});
      expect(output).toBe('pong');
    });

    it('returns true when enabling an already-enabled plugin (idempotent)', async () => {
      const plugins: DronePlugin[] = [
        createTestPlugin({ id: 'always', defaultEnabled: true }),
      ];

      const engine = createDronePluginEngine({
        plugins,
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      const result = await engine.enablePlugin('always');
      expect(result).toBe(true);
    });

    it('returns false for an unknown plugin ID', async () => {
      const plugins: DronePlugin[] = [
        createTestPlugin({ id: 'known' }),
      ];

      const engine = createDronePluginEngine({
        plugins,
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      const result = await engine.enablePlugin('nonexistent');
      expect(result).toBe(false);
    });

    it('throws when a hard dependency is not enabled', async () => {
      const plugins: DronePlugin[] = [
        createTestPlugin({
          id: 'dependent',
          defaultEnabled: false,
          dependencies: [{ id: 'missing-dep' }],
        }),
      ];

      const engine = createDronePluginEngine({
        plugins,
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      await expect(engine.enablePlugin('dependent')).rejects.toThrow(
        /requires dependency missing-dep which is not enabled/
      );
    });

    it('succeeds when an optional dependency is not enabled', async () => {
      const plugins: DronePlugin[] = [
        createTestPlugin({
          id: 'flexible',
          defaultEnabled: false,
          dependencies: [{ id: 'optional-dep', optional: true }],
        }),
      ];

      const engine = createDronePluginEngine({
        plugins,
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      const result = await engine.enablePlugin('flexible');
      expect(result).toBe(true);
    });

    it('runs onPluginsLoaded and onSessionStart hooks when enabling mid-session', async () => {
      const calls: string[] = [];

      const plugins: DronePlugin[] = [
        createTestPlugin({
          id: 'late',
          defaultEnabled: false,
          hooks: {
            onPluginsLoaded: async () => { calls.push('late:loaded'); },
            onSessionStart: async () => { calls.push('late:start'); },
          },
        }),
      ];

      const engine = createDronePluginEngine({
        plugins,
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();
      await engine.runHooks('onPluginsLoaded');
      await engine.runHooks('onSessionStart');

      // Not called during init since plugin was disabled
      expect(calls).toEqual([]);

      // Enable — hooks should fire
      await engine.enablePlugin('late');
      expect(calls).toEqual(['late:loaded', 'late:start']);
    });

    it('registers workflows when enabling', async () => {
      const plugins: DronePlugin[] = [
        createTestPlugin({
          id: 'wf',
          defaultEnabled: false,
          workflows: [{
            name: 'setup',
            description: 'Setup workflow',
            inputSchema: { type: 'object', additionalProperties: false },
            run: async () => ({ toolResult: 'done' }),
          }],
        }),
      ];

      const engine = createDronePluginEngine({
        plugins,
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      // Workflow not available before enabling
      await expect(engine.runWorkflow('wf.setup', {})).rejects.toThrow(/Unknown workflow/);

      // Enable — workflow should now be registered
      await engine.enablePlugin('wf');
      // Workflow exists now but needs elicitation; we just confirm it's registered
      // by checking it doesn't throw 'Unknown workflow'
      try {
        await engine.runWorkflow('wf.setup', {});
      } catch (err) {
        // It should throw about missing elicitation, not unknown workflow
        expect((err as Error).message).not.toMatch(/Unknown workflow/);
      }
    });
  });
});
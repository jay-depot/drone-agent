import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultAgentConfig,
  createDebugFlagRegistry,
  filterByGlobPatterns,
  toToolResultContent,
  type DronePlugin,
  type DroneSessionSafetyTrimPayload,
  type DroneToolDescriptor,
  type DroneToolDefinition,
} from 'drone-core';
import {
  createDronePluginEngine,
  getDefaultEnabledPluginIds,
} from '../src/runtime/plugin-engine.js';
import { createTestPlugin, silentLogger } from './helpers.js';

const RUNTIME_TOOL_COUNT = 3; // runtime__list_tools, runtime__mount_tool, runtime__unmount_tool

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

  it('computes default-enabled plugin ids from metadata', () => {
    const plugins: DronePlugin[] = [
      createTestPlugin({
        id: 'required',
        required: true,
        defaultEnabled: false,
      }),
      createTestPlugin({ id: 'default-on', defaultEnabled: true }),
      createTestPlugin({ id: 'opt-in', defaultEnabled: false }),
    ];

    expect(getDefaultEnabledPluginIds(plugins)).toEqual([
      'required',
      'default-on',
    ]);
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
    expect(tools).toHaveLength(RUNTIME_TOOL_COUNT);
    // Mount the tool to make it visible
    engine.executeTool('runtime__mount_tool', { tool: 'echo-plugin__echo' });
    expect(engine.getTool('echo-plugin__echo')).toBeDefined();
    expect(engine.getTool('missing')).toBeUndefined();

    const output = await engine.executeTool('echo-plugin__echo', {
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

  describe('unregisterTool', () => {
    it('removes a single tool by canonical name', async () => {
      const toolA: DroneToolDefinition = {
        name: 'alpha',
        description: 'alpha tool',
        execute: async () => 'a',
      };
      const toolB: DroneToolDefinition = {
        name: 'beta',
        description: 'beta tool',
        execute: async () => 'b',
      };

      const engine = createDronePluginEngine({
        plugins: [createTestPlugin({ id: 'test', tools: [toolA, toolB] })],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      // Mount the tools so they appear in listTools()
      await engine.executeTool('runtime__mount_tool', { tool: 'test__alpha' });
      await engine.executeTool('runtime__mount_tool', { tool: 'test__beta' });
      expect(engine.getTool('test__alpha')).toBeDefined();
      expect(engine.getTool('test__beta')).toBeDefined();
      expect(engine.listTools()).toHaveLength(RUNTIME_TOOL_COUNT + 2);

      engine.unregisterTool('test__alpha');

      expect(engine.getTool('test__alpha')).toBeUndefined();
      expect(engine.getTool('test__beta')).toBeDefined();
      expect(engine.listTools()).toHaveLength(RUNTIME_TOOL_COUNT + 1);
    });

    it('silently does nothing for an unknown tool name', async () => {
      const engine = createDronePluginEngine({
        plugins: [createTestPlugin({ id: 'test' })],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      engine.unregisterTool('test__nonexistent');
      expect(engine.listTools()).toHaveLength(RUNTIME_TOOL_COUNT);
    });

    it('allows re-registering a tool after unregistering it', async () => {
      let registerToolFn: ((tool: DroneToolDefinition) => void) | undefined;

      const engine = createDronePluginEngine({
        plugins: [
          createTestPlugin({
            id: 'test',
            tools: [
              { name: 'temp', description: 'temp', execute: async () => 't' },
            ],
            register: ({ registerTool }) => {
              registerToolFn = registerTool;
            },
          }),
        ],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      expect(engine.getTool('test__temp')).toBeDefined();
      engine.unregisterTool('test__temp');
      expect(engine.getTool('test__temp')).toBeUndefined();

      // Re-register the same tool — should not throw
      registerToolFn!({
        name: 'temp',
        description: 'temp',
        execute: async () => 't',
      });
      expect(engine.getTool('test__temp')).toBeDefined();
    });
  });

  describe('registration.listMountedTools', () => {
    it('reflects toolRegistry mount state', async () => {
      const toolA: DroneToolDefinition = {
        name: 'alpha',
        description: 'alpha tool',
        execute: async () => 'a',
      };
      const toolB: DroneToolDefinition = {
        name: 'beta',
        description: 'beta tool',
        execute: async () => 'b',
      };

      let listMountedFn: (() => DroneToolDescriptor[]) | undefined;
      let mountFn:
        ((name: string) => DroneToolDefinition | undefined) | undefined;
      let unmountFn: ((name: string) => void) | undefined;

      const engine = createDronePluginEngine({
        plugins: [
          createTestPlugin({
            id: 'test',
            tools: [toolA, toolB],
            register: registration => {
              listMountedFn = registration.listMountedTools;
              mountFn = registration.mountTool;
              unmountFn = registration.unmountTool;
            },
          }),
        ],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      // Initially only runtime tools are mounted
      const initial = listMountedFn!();
      expect(initial.length).toBe(RUNTIME_TOOL_COUNT);
      expect(initial.every(t => t.name.startsWith('runtime__'))).toBe(true);

      // Mount a tool via the registration API
      const def = mountFn!('test__alpha');
      expect(def).toBeDefined();
      const mounted = listMountedFn!();
      expect(mounted.map(t => t.name)).toContain('test__alpha');
      expect(mounted.map(t => t.name)).not.toContain('test__beta');

      // Unmount and verify it disappears
      unmountFn!('test__alpha');
      const after = listMountedFn!();
      expect(after.map(t => t.name)).not.toContain('test__alpha');
    });
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
      expect(engine.getTool('bootstrap__ping')).toBeUndefined();
      expect(
        engine.listPlugins().find(p => p.id === 'bootstrap')?.enabled
      ).toBe(false);

      // Enable it
      const result = await engine.enablePlugin('bootstrap');
      expect(result).toBe(true);
      expect(engine.getTool('bootstrap__ping')).toBeDefined();
      expect(
        engine.listPlugins().find(p => p.id === 'bootstrap')?.enabled
      ).toBe(true);

      // Tool is callable
      const output = await engine.executeTool('bootstrap__ping', {});
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
      const plugins: DronePlugin[] = [createTestPlugin({ id: 'known' })];

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
            onPluginsLoaded: async () => {
              calls.push('late:loaded');
            },
            onSessionStart: async () => {
              calls.push('late:start');
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
          workflows: [
            {
              name: 'setup',
              description: 'Setup workflow',
              inputSchema: { type: 'object', additionalProperties: false },
              run: async () => ({ toolResult: 'done' }),
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

      // Workflow not available before enabling
      await expect(engine.runWorkflow('wf__setup', {})).rejects.toThrow(
        /Unknown workflow/
      );

      // Enable — workflow should now be registered
      await engine.enablePlugin('wf');
      // Workflow exists now but needs elicitation; we just confirm it's registered
      // by checking it doesn't throw 'Unknown workflow'
      try {
        await engine.runWorkflow('wf__setup', {});
      } catch (err) {
        // It should throw about missing elicitation, not unknown workflow
        expect((err as Error).message).not.toMatch(/Unknown workflow/);
      }
    });
  });
});

describe('runtime__list_tools — tool visibility filtering', () => {
  // A persona capability whose getFilteredTools hides defaultHidden tools
  // when no allowedTools are present (mirrors the persona plugin's behavior).
  function makeDefaultHiddenPersonaCap(): {
    getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  } {
    return {
      getFilteredTools: (tools: DroneToolDescriptor[]) =>
        tools.filter(t => !t.defaultHidden),
    };
  }

  // A persona capability whose getFilteredTools applies allowedTools globs
  // (mirrors the persona plugin's behavior when a persona has allowedTools).
  function makeAllowedToolsPersonaCap(allowedTools: string[]): {
    getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  } {
    return {
      getFilteredTools: (tools: DroneToolDescriptor[]) => {
        const names = tools.map(t => t.name);
        const filtered = filterByGlobPatterns(names, allowedTools);
        const filteredSet = new Set(filtered);
        return tools.filter(t => filteredSet.has(t.name));
      },
    };
  }

  function makeToolPlugin(): DronePlugin {
    return createTestPlugin({
      id: 'term',
      tools: [
        {
          name: 'create',
          description: 'create a terminal session',
          defaultHidden: true,
          execute: async () => 'ok',
        },
        {
          name: 'list',
          description: 'list terminal sessions',
          execute: async () => 'ok',
        },
      ],
    });
  }

  async function listToolNames(plugins: DronePlugin[]): Promise<string[]> {
    const engine = createDronePluginEngine({
      plugins,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();
    const result = JSON.parse(
      toToolResultContent(await engine.executeTool('runtime__list_tools', {}))
    );
    return (result.tools as Array<{ name: string }>).map(t => t.name);
  }

  it('filters default-hidden tools when a persona is active without allowedTools', async () => {
    const personaPlugin = createTestPlugin({
      id: 'persona',
      capability: makeDefaultHiddenPersonaCap(),
    });
    const names = await listToolNames([personaPlugin, makeToolPlugin()]);
    expect(names).toContain('term__list');
    expect(names).not.toContain('term__create');
  });

  it('filters default-hidden tools when no persona is active', async () => {
    const personaPlugin = createTestPlugin({
      id: 'persona',
      capability: makeDefaultHiddenPersonaCap(),
    });
    const names = await listToolNames([personaPlugin, makeToolPlugin()]);
    expect(names).toContain('term__list');
    expect(names).not.toContain('term__create');
  });

  it('allows a persona with allowedTools to re-include a default-hidden tool', async () => {
    const personaPlugin = createTestPlugin({
      id: 'persona',
      capability: makeAllowedToolsPersonaCap(['term__create']),
    });
    const names = await listToolNames([personaPlugin, makeToolPlugin()]);
    expect(names).toContain('term__create');
    expect(names).not.toContain('term__list');
  });

  it('filters default-hidden tools when no persona capability is present', async () => {
    const names = await listToolNames([makeToolPlugin()]);
    expect(names).toContain('term__list');
    expect(names).not.toContain('term__create');
  });
});

describe('--debug tools — tool surface change logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTool(name: string): DroneToolDefinition {
    return {
      name,
      description: `${name} tool`,
      execute: async () => 'ok',
    };
  }

  it('logs mount/unmount/register/unregister when tools debug is enabled', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugFlags = createDebugFlagRegistry(['tools']);

    const engine = createDronePluginEngine({
      plugins: [createTestPlugin({ id: 'test', tools: [makeTool('alpha')] })],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      debugFlags,
    });
    await engine.initialize();

    // Mount via runtime meta-tool
    await engine.executeTool('runtime__mount_tool', { tool: 'test__alpha' });
    // Unmount via runtime meta-tool
    await engine.executeTool('runtime__unmount_tool', { tool: 'test__alpha' });
    // Unregister
    engine.unregisterTool('test__alpha');

    const lines = errorSpy.mock.calls.map(c => c[0] as string);
    expect(lines).toContain('[tools:register] test__alpha');
    expect(lines).toContain('[tools:mount] test__alpha');
    expect(lines).toContain('[tools:unmount] test__alpha');
    expect(lines).toContain('[tools:unregister] test__alpha');
  });

  it('logs nothing when tools debug is disabled', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugFlags = createDebugFlagRegistry();

    const engine = createDronePluginEngine({
      plugins: [createTestPlugin({ id: 'test', tools: [makeTool('alpha')] })],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      debugFlags,
    });
    await engine.initialize();

    await engine.executeTool('runtime__mount_tool', { tool: 'test__alpha' });
    await engine.executeTool('runtime__unmount_tool', { tool: 'test__alpha' });
    engine.unregisterTool('test__alpha');

    const lines = errorSpy.mock.calls.map(c => c[0] as string);
    expect(lines.filter(l => l.startsWith('[tools:'))).toEqual([]);
  });

  it('logs enable-plugin and add-external-plugin when tools debug is enabled', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugFlags = createDebugFlagRegistry(['tools']);

    const engine = createDronePluginEngine({
      plugins: [
        createTestPlugin({ id: 'late', defaultEnabled: false }),
        createTestPlugin({ id: 'external', defaultEnabled: false }),
      ],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      debugFlags,
    });
    await engine.initialize();

    await engine.enablePlugin('late');
    await engine.addExternalPlugin(
      createTestPlugin({ id: 'ext', defaultEnabled: false })
    );

    const lines = errorSpy.mock.calls.map(c => c[0] as string);
    expect(lines).toContain('[tools:enable-plugin] late');
    expect(lines).toContain('[tools:add-external-plugin] ext');
  });

  it('exposes _runtime capability during plugin registration', async () => {
    const capturedRuntime: Array<{
      isSubagent: boolean;
      subagentId?: string;
    }> = [];

    const plugin = createTestPlugin({
      id: 'runtime-probe',
      register: registration => {
        capturedRuntime.push(
          registration.request<{ isSubagent: boolean; subagentId?: string }>(
            'runtime'
          )!
        );
      },
    });

    // Main-agent mode (no subagentId)
    const engine = createDronePluginEngine({
      plugins: [plugin],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();
    expect(capturedRuntime[0]).toBeDefined();
    expect(capturedRuntime[0].isSubagent).toBe(false);

    // Subagent mode (with subagentId)
    const subagentEngine = createDronePluginEngine({
      plugins: [plugin],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      runtimeOptions: { subagentId: 'subagent-test-123' },
    });
    await subagentEngine.initialize();
    expect(capturedRuntime[1]).toBeDefined();
    expect(capturedRuntime[1].isSubagent).toBe(true);
    expect(capturedRuntime[1].subagentId).toBe('subagent-test-123');
  });
});

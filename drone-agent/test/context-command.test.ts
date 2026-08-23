import { describe, expect, it, vi } from 'vitest';
import type {
  DroneLlmCapability,
  DronePluginRegistration,
  DroneSlashCommand,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { llmPlugin } from '../src/plugins/llm/index.js';
import { silentLogger } from './helpers.js';

async function captureContextCommand(options?: {
  probeResult?: Record<string, unknown> | null;
}): Promise<{
  command: DroneSlashCommand;
  capability: DroneLlmCapability;
  config: ReturnType<typeof createDefaultAgentConfig>;
}> {
  const config = createDefaultAgentConfig();
  config.providers = {
    ollama: { protocol: 'ollama', models: {} },
  };
  config.llm.active = 'ollama/llama3.1';

  let offeredCapability: DroneLlmCapability | undefined;
  let contextCommand: DroneSlashCommand | undefined;
  const loadedHooks: Array<() => Promise<void>> = [];

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => config,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: command => {
      if (command.command === '/context') {
        contextCommand = command;
      }
    },
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    hooks: {
      onPluginsLoaded: cb => {
        loadedHooks.push(cb);
      },
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: cap => {
      offeredCapability = cap as DroneLlmCapability;
    },
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };

  await llmPlugin.register(registration);
  const capability = offeredCapability!;
  capability.registerDriver({
    protocolId: 'ollama',
    createProvider: () => ({
      chat: async () => ({ message: 'ok' }),
      getContextWindowInfo: async () =>
        (options?.probeResult ?? {
          model: 'llama3.1',
          contextWindowTokens: 16384,
          source: 'provider',
          detail: 'driver pin 16384',
        }) as never,
    }),
    parameterSchema: { parameters: {} },
  });
  for (const hook of loadedHooks) {
    await hook();
  }

  if (!contextCommand) {
    throw new Error('Expected /context slash command to be registered.');
  }
  return { command: contextCommand, capability, config };
}

function makeCommandContext(
  config: ReturnType<typeof createDefaultAgentConfig>
): {
  ctx: Parameters<
    DroneSlashCommand['handler']
  >[0];
  infos: string[];
  warns: string[];
} {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    ctx: {
      line: '/context',
      args: [],
      engine: {
        getConfig: () => config,
        getCapability: () => undefined,
      } as never,
      conversation: {
        getEstimatedContextUsagePercent: vi.fn(async () => 7.25),
      } as never,
      logger: {
        info: (msg: string) => infos.push(msg),
        warn: (msg: string) => warns.push(msg),
        error: () => {},
      } as never,
      sessionManager: {} as never,
    } as never,
    infos,
    warns,
  };
}

describe('/context command', () => {
  it('renders window, source, detail, reserve, and usage', async () => {
    const { command, config } = await captureContextCommand();
    const { ctx, infos, warns } = makeCommandContext(config);

    const handled = await command.handler(ctx);

    expect(handled).toBe(true);
    expect(warns).toHaveLength(0);
    const output = infos.join('\n');
    expect(output).toContain('Model: ollama/llama3.1');
    expect(output).toContain('16,384 tokens');
    expect(output).toContain('source: provider');
    expect(output).toContain(', driver pin 16384)');
    expect(output).toContain('Response reserve: 4,096 tokens');
    expect(output).toContain('Estimated usage: 7.3%');
  });

  it('omits the detail suffix when the probe supplies none', async () => {
    const { command, config } = await captureContextCommand({
      probeResult: {
        model: 'llama3.1',
        contextWindowTokens: 32768,
        source: 'config',
      },
    });
    const { ctx, infos } = makeCommandContext(config);

    await command.handler(ctx);

    expect(infos.join('\n')).toContain('(source: config)');
    // No detail suffix directly after the source (number formatting may
    // still contain thousands separators).
    expect(infos.join('\n')).not.toContain('(source: config,');
  });

  it('warns gracefully when no provider can be activated', async () => {
    const config = createDefaultAgentConfig();
    config.providers = {};
    config.llm.active = '';

    let contextCommand: DroneSlashCommand | undefined;
    const registration: DronePluginRegistration = {
      logger: silentLogger(),
      getConfig: () => config,
      registerTool: () => {},
      registerPromptFragment: () => {},
      registerHelp: () => {},
      registerWorkflow: () => {},
      registerSlashCommand: command => {
        if (command.command === '/context') {
          contextCommand = command;
        }
      },
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
      request: <T>() => undefined as T | undefined,
      runWorkflow: async () => ({ toolResult: '{}' }),
      requestElicitation: () => undefined,
    };
    await llmPlugin.register(registration);
    expect(contextCommand).toBeDefined();

    const infos: string[] = [];
    const warns: string[] = [];
    const handled = await contextCommand!.handler({
      line: '/context',
      args: [],
      engine: {
        getConfig: () => config,
        getCapability: () => undefined,
      } as never,
      conversation: undefined as never,
      logger: {
        info: (msg: string) => infos.push(msg),
        warn: (msg: string) => warns.push(msg),
        error: () => {},
      } as never,
      sessionManager: {} as never,
    } as never);

    expect(handled).toBe(true);
    expect(infos).toHaveLength(0);
    expect(warns[0]).toContain('No active LLM provider');
  });
});

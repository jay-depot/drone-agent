import { describe, expect, it, vi } from 'vitest';
import type {
  DroneLlmCapability,
  DronePluginRegistration,
  DroneSlashCommand,
  DroneSlashCommandContext,
  LlmProtocolDriver,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { llmPlugin } from '../src/plugins/llm/index.js';
import { silentLogger } from './helpers.js';

type Capture = {
  capability: DroneLlmCapability;
  modelCommand: DroneSlashCommand;
  runLoadedHooks: () => Promise<void>;
};

async function captureLlmPlugin(
  providers: Record<string, { protocol: string; models: string[] }>,
  llmActive?: string
): Promise<Capture> {
  const config = createDefaultAgentConfig();
  config.providers = Object.fromEntries(
    Object.entries(providers).map(([id, spec]) => [
      id,
      {
        protocol: spec.protocol,
        models: Object.fromEntries(spec.models.map(m => [m, {}])),
      },
    ])
  );
  if (llmActive) {
    config.llm.active = llmActive;
  }

  let offeredCapability: DroneLlmCapability | undefined;
  let modelCommand: DroneSlashCommand | undefined;
  const loadedHooks: Array<() => Promise<void>> = [];

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => config,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: command => {
      if (command.command === '/model') {
        modelCommand = command;
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

  if (!offeredCapability) {
    throw new Error('Expected llm capability to be offered.');
  }
  if (!modelCommand) {
    throw new Error('Expected /model slash command to be registered.');
  }

  return {
    capability: offeredCapability,
    modelCommand,
    runLoadedHooks: async () => {
      for (const hook of loadedHooks) {
        await hook();
      }
    },
  };
}

function makeDriver(protocolId: string): LlmProtocolDriver {
  return {
    protocolId,
    createProvider: () => ({
      chat: async () => ({ message: 'ok' }),
      getContextWindowInfo: async () => null,
    }),
    parameterSchema: { parameters: {} },
  };
}

function makeCommandContext(
  capability: DroneLlmCapability
): DroneSlashCommandContext {
  const configCap = {
    setValue: vi.fn(async () => {}),
  };
  const ctx = {
    line: '/model',
    args: [] as string[],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    engine: {
      executeTool: async () => '',
      runHooks: async () => {},
      getCapability: <T>(id: string) =>
        (id === 'llm'
          ? capability
          : id === 'config'
            ? configCap
            : undefined) as T,
    },
    conversation: {
      getModel: () => capability.getModel(),
      setModel: (model: string) => capability.setModel(model),
      getReasoningLevel: () => undefined,
      setReasoningLevel: (_level: never) => {},
      sendUserMessage: async () => '',
      enqueueUserMessage: (_p: string) => {},
      cancelCurrentRequest: () => {},
      getDebugSubsystems: () => [],
      enableDebugSubsystem: () => {},
      disableDebugSubsystem: () => {},
    },
  } as unknown as DroneSlashCommandContext & {
    engine: { configCapability: typeof configCap };
  };
  // Expose the config capability spy for assertions.
  (ctx as unknown as { __configCap: typeof configCap }).__configCap = configCap;
  return ctx;
}

describe('llm plugin provider switching', () => {
  it('activates llm.active provider+model via onPluginsLoaded', async () => {
    const { capability, runLoadedHooks } = await captureLlmPlugin(
      {
        ollama: { protocol: 'ollama', models: ['llama3.1'] },
        openrouter: {
          protocol: 'openrouter',
          models: ['openai/gpt-4o', 'openai/gpt-4.1'],
        },
      },
      'openrouter/openai/gpt-4.1'
    );

    capability.registerDriver(makeDriver('ollama'));
    capability.registerDriver(makeDriver('openrouter'));
    await runLoadedHooks();

    expect(capability.getActiveProviderId()).toBe('openrouter');
    expect(capability.getModel()).toBe('openai/gpt-4.1');
  });

  it('falls back to the first declared model when activating without a selection', async () => {
    const { capability } = await captureLlmPlugin({
      ollama: { protocol: 'ollama', models: ['llama3.1', 'qwen3'] },
    });

    capability.registerDriver(makeDriver('ollama'));
    capability.activateProvider('ollama');
    expect(capability.getModel()).toBe('llama3.1');
  });

  it('throws a clear error when provider id is unknown', async () => {
    const { capability } = await captureLlmPlugin({
      ollama: { protocol: 'ollama', models: ['llama3.1'] },
    });

    expect(() => capability.activateProvider('missing')).toThrow(/missing/);
  });

  it('/model <provider/model> switches and persists to user scope', async () => {
    const { capability, modelCommand } = await captureLlmPlugin(
      {
        ollama: { protocol: 'ollama', models: ['llama3.1'] },
        openrouter: {
          protocol: 'openrouter',
          models: ['openai/gpt-4o', 'openai/gpt-4.1'],
        },
      },
      'ollama/llama3.1'
    );

    capability.registerDriver(makeDriver('ollama'));
    capability.registerDriver(makeDriver('openrouter'));
    capability.activateProvider('ollama');

    const ctx = makeCommandContext(capability);
    ctx.line = '/model openrouter/openai/gpt-4.1';
    ctx.args = ['openrouter/openai/gpt-4.1'];

    const handled = await modelCommand.handler(ctx);

    expect(handled).toBe(true);
    expect(capability.getActiveProviderId()).toBe('openrouter');
    expect(capability.getModel()).toBe('openai/gpt-4.1');
    const configCap = (
      ctx as unknown as { __configCap: { setValue: ReturnType<typeof vi.fn> } }
    ).__configCap;
    expect(configCap.setValue).toHaveBeenCalledWith(
      'user',
      'llm.active',
      'openrouter/openai/gpt-4.1'
    );
  });

  it('/model --once switches without persisting', async () => {
    const { capability, modelCommand } = await captureLlmPlugin(
      {
        ollama: { protocol: 'ollama', models: ['llama3.1'] },
        openrouter: {
          protocol: 'openrouter',
          models: ['openai/gpt-4o'],
        },
      },
      'ollama/llama3.1'
    );

    capability.registerDriver(makeDriver('ollama'));
    capability.registerDriver(makeDriver('openrouter'));
    capability.activateProvider('ollama');

    const ctx = makeCommandContext(capability);
    ctx.line = '/model --once openrouter/openai/gpt-4o';
    ctx.args = ['--once', 'openrouter/openai/gpt-4o'];

    const handled = await modelCommand.handler(ctx);

    expect(handled).toBe(true);
    expect(capability.getActiveProviderId()).toBe('openrouter');
    expect(capability.getModel()).toBe('openai/gpt-4o');
    const configCap = (
      ctx as unknown as { __configCap: { setValue: ReturnType<typeof vi.fn> } }
    ).__configCap;
    expect(configCap.setValue).not.toHaveBeenCalled();
  });

  it('resolves bare ids against the active provider', async () => {
    const { capability, modelCommand } = await captureLlmPlugin(
      {
        ollama: { protocol: 'ollama', models: ['llama3.1', 'qwen3'] },
      },
      'ollama/llama3.1'
    );

    capability.registerDriver(makeDriver('ollama'));
    capability.activateProvider('ollama');

    const ctx = makeCommandContext(capability);
    ctx.line = '/model qwen3';
    ctx.args = ['qwen3'];

    await modelCommand.handler(ctx);

    expect(capability.getActiveProviderId()).toBe('ollama');
    expect(capability.getModel()).toBe('qwen3');
  });

  it('fails fast when selecting a model unavailable on any provider', async () => {
    const { capability, modelCommand } = await captureLlmPlugin(
      {
        ollama: { protocol: 'ollama', models: ['llama3.1'] },
      },
      'ollama/llama3.1'
    );

    capability.registerDriver(makeDriver('ollama'));
    capability.activateProvider('ollama');

    const ctx = makeCommandContext(capability);
    ctx.line = '/model not-real';
    ctx.args = ['not-real'];

    const handled = await modelCommand.handler(ctx);

    expect(handled).toBe(true);
    expect(capability.getModel()).toBe('llama3.1');
    expect(ctx.logger.warn).toHaveBeenCalled();
  });
});

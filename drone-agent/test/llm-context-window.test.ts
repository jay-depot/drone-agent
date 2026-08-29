import { describe, expect, it, vi } from 'vitest';
import type {
  DroneLlmCapability,
  DronePluginRegistration,
  LlmProtocolDriver,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { llmPlugin } from '../src/plugins/llm/index.js';
import { silentLogger } from './helpers.js';

/**
 * Harness for exercising the broker's getContextWindowInfo wrapper:
 * declared ⊕ discovered catalog data first ('metadata'), then the driver's
 * live probe, then the session-config fallback.
 */
async function captureWindowCapability(options: {
  providers: Record<
    string,
    {
      protocol: string;
      extra?: Record<string, unknown>;
      models: Record<
        string,
        {
          contextWindow?: number;
          model?: string;
          parameters?: Record<string, unknown>;
        }
      >;
    }
  >;
  llmActive?: string;
  driver?: LlmProtocolDriver;
}): Promise<{
  capability: DroneLlmCapability;
}> {
  const config = createDefaultAgentConfig();
  config.providers = Object.fromEntries(
    Object.entries(options.providers).map(([id, spec]) => [
      id,
      {
        protocol: spec.protocol,
        ...(spec.extra ? { extra: spec.extra } : {}),
        models: Object.fromEntries(
          Object.entries(spec.models).map(([modelId, meta]) => [modelId, meta])
        ),
      },
    ])
  );
  if (options.llmActive) {
    config.llm.active = options.llmActive;
  }

  let offeredCapability: DroneLlmCapability | undefined;

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => config,
    registerTool: () => {},
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

  const loadedHooks: Array<() => Promise<void>> = [];

  await llmPlugin.register(registration);

  if (!offeredCapability) {
    throw new Error('Expected llm capability to be offered.');
  }
  if (options.driver) {
    offeredCapability.registerDriver(options.driver);
  }
  for (const hook of loadedHooks) {
    await hook();
  }

  return { capability: offeredCapability };
}

function makeDriverWithProbe(
  protocolId: string,
  probe: (args: {
    model: string;
    parameters?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  }) => Promise<{
    model: string;
    contextWindowTokens: number;
    source: 'provider' | 'default';
    detail?: string;
  } | null>
): LlmProtocolDriver {
  return {
    protocolId,
    createProvider: () => ({
      chat: async () => ({ message: 'ok' }),
      getContextWindowInfo: probe,
    }),
    parameterSchema: { parameters: {} },
  };
}

describe('broker context-window resolution', () => {
  it('uses declared models[id].contextWindow without calling the driver probe', async () => {
    const probe = vi.fn(async () => null);
    const { capability } = await captureWindowCapability({
      providers: {
        anthropic: {
          protocol: 'anthropic',
          models: { 'claude-sonnet-4-6': { contextWindow: 1_000_000 } },
        },
      },
      llmActive: 'anthropic/claude-sonnet-4-6',
      driver: makeDriverWithProbe('anthropic', probe),
    });

    const info = await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    expect(info).toEqual({
      model: 'anthropic/claude-sonnet-4-6',
      contextWindowTokens: 1_000_000,
      source: 'metadata',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('prefers discovered metadata over the driver probe when undeclared', async () => {
    // Discovery cache is populated by buildModelListing(); drive it through
    // the public surface by stubbing the driver's discoverModels and listing
    // models once. The broker stores discovered entries keyed by full id.
    const probe = vi.fn(async () => null);
    const driver: LlmProtocolDriver = {
      protocolId: 'ollama',
      createProvider: () => ({
        chat: async () => ({ message: 'ok' }),
        getContextWindowInfo: probe,
      }),
      discoverModels: async () => [{ id: 'llama3.1', contextWindow: 131072 }],
      parameterSchema: { parameters: {} },
    };
    const { capability } = await captureWindowCapability({
      providers: {
        ollama: { protocol: 'ollama', models: {} },
      },
      llmActive: 'ollama/llama3.1',
      driver,
    });

    // Populate the discovery cache via listModels().
    await capability.listModels();

    const info = await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    expect(info).toEqual({
      model: 'ollama/llama3.1',
      contextWindowTokens: 131072,
      source: 'metadata',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('falls back to the live driver probe when no metadata exists', async () => {
    const probe = vi.fn(async ({ model }: { model: string }) => ({
      model,
      contextWindowTokens: 8192,
      source: 'default' as const,
    }));
    const { capability } = await captureWindowCapability({
      providers: {
        ollama: { protocol: 'ollama', models: {} },
      },
      llmActive: 'ollama/llama3.1',
      driver: makeDriverWithProbe('ollama', probe),
    });

    const info = await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    expect(info).toMatchObject({
      model: 'ollama/llama3.1',
      contextWindowTokens: 8192,
      source: 'default',
    });
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'llama3.1' })
    );
  });

  it('honors one-level alias base metadata', async () => {
    const probe = vi.fn(async () => null);
    const { capability } = await captureWindowCapability({
      providers: {
        openai: {
          protocol: 'openai',
          models: {
            'gpt-4.1': { contextWindow: 1_047_576 },
            fast: { model: 'gpt-4.1' },
          },
        },
      },
      llmActive: 'openai/fast',
      driver: makeDriverWithProbe('openai', probe),
    });

    const info = await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    expect(info).toEqual({
      model: 'openai/fast',
      contextWindowTokens: 1_047_576,
      source: 'metadata',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('falls back to session.contextWindowTokens when nothing resolves', async () => {
    const { capability } = await captureWindowCapability({
      providers: {
        ollama: { protocol: 'ollama', models: {} },
      },
      llmActive: 'ollama/llama3.1',
      driver: makeDriverWithProbe('ollama', async () => null),
    });

    const info = await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    expect(info).toMatchObject({
      model: 'ollama/llama3.1',
      source: 'config',
    });
    expect(info?.contextWindowTokens).toBeGreaterThan(0);
  });

  it('reflects model switches without stale caching', async () => {
    const { capability } = await captureWindowCapability({
      providers: {
        ollama: {
          protocol: 'ollama',
          models: {
            small: { contextWindow: 8192 },
            big: { contextWindow: 1_000_000 },
          },
        },
      },
      llmActive: 'ollama/small',
      driver: makeDriverWithProbe('ollama', async () => null),
    });

    const small = await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    expect(small?.contextWindowTokens).toBe(8192);

    capability.setModel('big');
    const big = await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    expect(big?.contextWindowTokens).toBe(1_000_000);

    capability.setModel('small');
    const backToSmall = await capability
      .getActiveProvider()
      .getContextWindowInfo?.({
        model: capability.getModel().split('/').pop() ?? '',
      });
    expect(backToSmall?.contextWindowTokens).toBe(8192);
  });

  it('logs provenance once per model', async () => {
    const logLines: string[] = [];
    const config = createDefaultAgentConfig();
    config.providers = {
      ollama: {
        protocol: 'ollama',
        models: { 'llama3.1': { contextWindow: 131072 } },
      },
    };
    config.llm.active = 'ollama/llama3.1';

    let offeredCapability: DroneLlmCapability | undefined;
    const loadedHooks: Array<() => Promise<void>> = [];
    const registration: DronePluginRegistration = {
      logger: {
        info: (msg: string) => logLines.push(msg),
        warn: () => {},
        error: () => {},
      },
      getConfig: () => config,
      registerTool: () => {},
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
    capability.registerDriver(makeDriverWithProbe('ollama', async () => null));
    for (const hook of loadedHooks) {
      await hook();
    }

    await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });

    const windowLines = logLines.filter(line =>
      line.includes('Context window for')
    );
    expect(windowLines).toHaveLength(1);
    expect(windowLines[0]).toContain('ollama/llama3.1');
    expect(windowLines[0]).toContain('131072');
    expect(windowLines[0]).toContain('metadata');
  });

  it('forwards merged effective parameters to the driver probe', async () => {
    const probe = vi.fn(async () => null);
    const { capability } = await captureWindowCapability({
      providers: {
        ollama: {
          protocol: 'ollama',
          models: { m: { parameters: { numCtx: 8192 } } },
        },
      },
      llmActive: 'ollama/m',
      driver: makeDriverWithProbe('ollama', probe),
    });

    await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'm',
        parameters: { numCtx: 8192 },
        extra: {},
      })
    );
  });

  it('forwards provider-level extra and merges model-level parameter wins', async () => {
    const probe = vi.fn(async () => null);
    const { capability } = await captureWindowCapability({
      providers: {
        ollama: {
          protocol: 'ollama',
          extra: { seed: 42 },
          models: {
            base: { parameters: { numCtx: 4096 } },
            alias: { model: 'base', parameters: { numCtx: 8192 } },
          },
        },
      },
      llmActive: 'ollama/alias',
      driver: makeDriverWithProbe('ollama', probe),
    });

    await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'base',
        parameters: { numCtx: 8192 },
        extra: { seed: 42 },
      })
    );
  });

  it('spreads probe detail through without adding it on metadata paths', async () => {
    const probe = vi.fn(async () => ({
      model: 'llama3.1',
      contextWindowTokens: 16384,
      source: 'provider' as const,
      detail: 'driver pin 16384',
    }));
    const { capability } = await captureWindowCapability({
      providers: {
        ollama: { protocol: 'ollama', models: {} },
      },
      llmActive: 'ollama/llama3.1',
      driver: makeDriverWithProbe('ollama', probe),
    });

    const info = await capability.getActiveProvider().getContextWindowInfo?.({
      model: capability.getModel().split('/').pop() ?? '',
    });
    expect(info).toMatchObject({
      model: 'ollama/llama3.1',
      contextWindowTokens: 16384,
      source: 'provider',
      detail: 'driver pin 16384',
    });
  });
});

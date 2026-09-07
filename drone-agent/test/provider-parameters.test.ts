import { describe, expect, it, vi, afterEach } from 'vitest';
import type { DroneLlmCapability, LlmProtocolDriver } from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { llmPlugin } from '../src/plugins/llm/index.js';
import { buildOllamaOptions } from '../src/plugins/ollama/driver.js';
import { silentLogger } from './helpers.js';

/**
 * Phase 5: parameters end-to-end. Resolution happens broker-side
 * (provider ⊕ model shallow merge, model wins; alias inherits base first)
 * and drivers normalize into their native payload shapes.
 */

async function captureBroker(
  providers: Record<string, unknown>,
  driverChat: ReturnType<typeof vi.fn>,
  parameterSchema: LlmProtocolDriver['parameterSchema'] = { parameters: {} },
  logger = silentLogger()
) {
  const config = createDefaultAgentConfig();
  config.providers = providers as never;

  let capability: DroneLlmCapability | undefined;
  const loadedHooks: Array<() => Promise<void>> = [];

  await llmPlugin.register({
    logger,
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
    emitEvent: () => {},
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
      capability = cap as DroneLlmCapability;
    },
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  });

  if (!capability) throw new Error('capability not offered');

  capability.registerDriver({
    protocolId: 'fake',
    createProvider: () => ({
      chat: driverChat as never,
    }),
    parameterSchema,
  });
  for (const hook of loadedHooks) {
    await hook();
  }
  return capability;
}

describe('parameter resolution precedence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provider-only parameters reach the driver request', async () => {
    const chat = vi.fn(async () => ({ message: 'ok' }));
    const capability = await captureBroker(
      {
        p: {
          protocol: 'fake',
          parameters: { temperature: 0.5 },
          models: { m: {} },
        },
      },
      chat
    );
    await capability!.getActiveProvider().chat({ model: 'm', messages: [] });
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: { temperature: 0.5 },
        extra: {},
      })
    );
  });

  it('model parameters win per key over provider parameters', async () => {
    const chat = vi.fn(async () => ({ message: 'ok' }));
    const capability = await captureBroker(
      {
        p: {
          protocol: 'fake',
          parameters: { temperature: 0.5, topP: 0.9 },
          models: { m: { parameters: { temperature: 0.1 } } },
        },
      },
      chat
    );
    await capability!.getActiveProvider().chat({ model: 'm', messages: [] });
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: { temperature: 0.1, topP: 0.9 },
      })
    );
  });

  it('aliased entries inherit base entry parameters (own wins)', async () => {
    const chat = vi.fn(async () => ({ message: 'ok' }));
    const capability = await captureBroker(
      {
        p: {
          protocol: 'fake',
          models: {
            base: { parameters: { topP: 0.9, numCtx: 4096 } },
            alias: { model: 'base', parameters: { numCtx: 8192 } },
          },
        },
      },
      chat
    );
    await capability!
      .getActiveProvider()
      .chat({ model: 'alias', messages: [] });
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: { topP: 0.9, numCtx: 8192 },
      })
    );
  });

  it('warns on schema-unknown parameters but still sends them', async () => {
    const warn = vi.fn();
    const chat = vi.fn(async () => ({ message: 'ok' }));
    const logger = { ...silentLogger(), warn };
    const capability = await captureBroker(
      {
        p: {
          protocol: 'fake',
          parameters: { temperature: 0.5, exoticKey: true },
          models: { m: {} },
        },
      },
      chat,
      { parameters: { temperature: { type: 'number' } } },
      logger as never
    );
    await capability!.getActiveProvider().chat({ model: 'm', messages: [] });
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: { temperature: 0.5, exoticKey: true },
      })
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exoticKey'));
  });

  it('does not warn for schema-known parameters', async () => {
    const warn = vi.fn();
    const chat = vi.fn(async () => ({ message: 'ok' }));
    const logger = { ...silentLogger(), warn };
    const capability = await captureBroker(
      {
        p: {
          protocol: 'fake',
          parameters: { temperature: 0.5 },
          models: { m: {} },
        },
      },
      chat,
      { parameters: { temperature: { type: 'number' } } },
      logger as never
    );
    await capability!.getActiveProvider().chat({ model: 'm', messages: [] });
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('temperature')
    );
  });

  it('resolves maxOutputTokens metadata into enriched requests', async () => {
    const chat = vi.fn(async () => ({ message: 'ok' }));
    const capability = await captureBroker(
      {
        p: {
          protocol: 'fake',
          models: { m: { maxOutputTokens: 2048, hasVision: true } },
        },
      },
      chat
    );
    await capability!.getActiveProvider().chat({ model: 'm', messages: [] });
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 2048,
        hasVision: true,
      })
    );
  });
});

describe('ollama options envelope end-to-end', () => {
  it('numCtx reaches the wire as options.num_ctx', () => {
    const options = buildOllamaOptions({
      parameters: { temperature: 0.7, numCtx: 16384 },
    });
    expect(options.num_ctx).toBe(16384);
    expect(options.temperature).toBe(0.7);
  });
});

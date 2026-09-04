import { describe, expect, it } from 'vitest';
import type {
  DroneChatRequest,
  DroneLlmCapability,
  DroneLogger,
  DroneModelEntryConfig,
  DronePluginRegistration,
  DroneReasoningLevel,
  LlmProtocolDriver,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { llmPlugin } from '../src/plugins/llm/index.js';
import { silentLogger } from './helpers.js';

/**
 * Harness for exercising the broker's resolveModelForRole. Registers the llm
 * plugin with a config whose providers/models can be pinned via `modelRoles`,
 * runs the onPluginsLoaded activation, and returns the offered capability.
 */
async function setupBroker(options: {
  providers: Record<
    string,
    { protocol: string; models: Record<string, DroneModelEntryConfig> }
  >;
  llmActive?: string;
  modelRoles?: Record<string, string>;
  drivers?: Record<string, LlmProtocolDriver>;
  logger?: DroneLogger;
}): Promise<{
  capability: DroneLlmCapability;
  config: ReturnType<typeof createDefaultAgentConfig>;
}> {
  const config = createDefaultAgentConfig();
  config.providers = Object.fromEntries(
    Object.entries(options.providers).map(([id, spec]) => [id, spec])
  );
  if (options.llmActive) config.llm.active = options.llmActive;
  if (options.modelRoles) config.llm.modelRoles = options.modelRoles;

  let offeredCapability: DroneLlmCapability | undefined;
  const loadedHooks: Array<() => Promise<void>> = [];

  const registration: DronePluginRegistration = {
    logger: options.logger ?? silentLogger(),
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
      offeredCapability = cap as DroneLlmCapability;
    },
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };

  await llmPlugin.register(registration);
  if (!offeredCapability) throw new Error('Expected llm capability.');
  for (const [, driver] of Object.entries(options.drivers ?? {})) {
    offeredCapability.registerDriver(driver);
  }
  // Ensure any ollama-provider tests have a driver so auto-activation works.
  if (!options.drivers?.ollama) {
    offeredCapability.registerDriver({
      protocolId: 'ollama',
      createProvider: () => ({
        chat: async () => ({ message: 'ok' }),
        getContextWindowInfo: async () => null,
      }),
      parameterSchema: { parameters: {} },
    });
  }
  for (const hook of loadedHooks) await hook();

  return { capability: offeredCapability, config };
}

/** A driver that records the chat requests it receives, for enrichment parity checks. */
function makeRecordingDriver(protocolId: string) {
  const calls: DroneChatRequest[] = [];
  const driver: LlmProtocolDriver = {
    protocolId,
    createProvider: () => ({
      chat: async request => {
        calls.push(request);
        return { message: 'ok' };
      },
    }),
    parameterSchema: { parameters: {} },
  };
  return { driver, calls };
}

const baseProviders = {
  ollama: {
    protocol: 'ollama',
    models: {
      'llama3.1': { contextWindow: 131072 },
      'vision-model': { contextWindow: 131072, hasVision: true },
    },
  },
};

describe('broker resolveModelForRole', () => {
  it('falls back to the active selection when the role is unset', async () => {
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/llama3.1',
    });
    const resolved = capability.resolveModelForRole('summarizer');
    expect(resolved.providerId).toBe('ollama');
    expect(resolved.model).toBe('llama3.1');
    expect(resolved.reasoningLevel).toBeUndefined();
  });

  it('resolves a configured role to its provider/model', async () => {
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/llama3.1',
      modelRoles: { summarizer: 'ollama/vision-model' },
    });
    const resolved = capability.resolveModelForRole('summarizer');
    expect(resolved.providerId).toBe('ollama');
    expect(resolved.model).toBe('vision-model');
  });

  it('falls back (warn-once) when the role references an unknown provider', async () => {
    const warnings: string[] = [];
    const logger: DroneLogger = {
      info: () => {},
      warn: m => warnings.push(String(m)),
      error: () => {},
    };
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/llama3.1',
      modelRoles: { summarizer: 'missing-provider/whatever' },
      logger,
    });
    capability.resolveModelForRole('summarizer');
    capability.resolveModelForRole('summarizer');
    expect(warnings).toHaveLength(1);
  });

  it('is stateless: never mutates the active selection', async () => {
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/llama3.1',
      modelRoles: { summarizer: 'ollama/vision-model' },
    });
    capability.resolveModelForRole('summarizer');
    expect(capability.getActiveProviderId()).toBe('ollama');
    expect(capability.getModel()).toBe('llama3.1');
  });

  it('returns the reasoning level from the resolved model entry', async () => {
    const { capability } = await setupBroker({
      providers: {
        ollama: {
          protocol: 'ollama',
          models: {
            'llama3.1': {},
            'thinking-model': { reasoningLevel: 'high' as DroneReasoningLevel },
          },
        },
      },
      llmActive: 'ollama/llama3.1',
      modelRoles: { summarizer: 'ollama/thinking-model' },
    });
    const resolved = capability.resolveModelForRole('summarizer');
    expect(resolved.reasoningLevel).toBe('high');
  });

  it('role-resolved provider.chat receives merged parameters/metadata', async () => {
    const recording = makeRecordingDriver('ollama');
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/llama3.1',
      modelRoles: { summarizer: 'ollama/vision-model' },
      drivers: { ollama: recording.driver },
    });
    const resolved = capability.resolveModelForRole('summarizer');
    await resolved.provider.chat({ model: 'vision-model', messages: [] });
    expect(recording.calls).toHaveLength(1);
    const sent = recording.calls[0];
    // Broker enrichment fills parameters and the declared hasVision metadata.
    expect(sent.parameters).toBeDefined();
    expect(sent.hasVision).toBe(true);
  });
});

describe('broker describeImages (D8 chain)', () => {
  it('uses the pinned image_describer when it is vision-capable', async () => {
    const recording = makeRecordingDriver('ollama');
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/llama3.1',
      modelRoles: { image_describer: 'ollama/vision-model' },
      drivers: { ollama: recording.driver },
    });
    const images = [{ mimeType: 'image/png', data: 'abc' }];
    const result = await capability.describeImages(images);
    expect(result[0].description).toBe('ok');
    expect(recording.calls).toHaveLength(1);
    const sent = recording.calls[0];
    expect(sent.model).toBe('vision-model');
    expect(sent.messages[1].images).toEqual(images);
  });

  it('falls back to the active selection when it is vision-capable', async () => {
    const recording = makeRecordingDriver('ollama');
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/vision-model',
      drivers: { ollama: recording.driver },
    });
    const result = await capability.describeImages([
      { mimeType: 'image/png', data: 'abc' },
    ]);
    expect(result[0].description).toBe('ok');
    expect(recording.calls[0].model).toBe('vision-model');
  });

  it('falls back to a vision-capable model in the pinned provider entry', async () => {
    const recording = makeRecordingDriver('ollama');
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/llama3.1',
      modelRoles: { image_describer: 'ollama/llama3.1' },
      drivers: { ollama: recording.driver },
    });
    const result = await capability.describeImages([
      { mimeType: 'image/png', data: 'abc' },
    ]);
    expect(result[0].description).toBe('ok');
    expect(recording.calls[0].model).toBe('vision-model');
  });

  it('falls back to any vision-capable model in breadth order', async () => {
    const recording = makeRecordingDriver('ollama');
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/llama3.1',
      drivers: { ollama: recording.driver },
    });
    const result = await capability.describeImages([
      { mimeType: 'image/png', data: 'abc' },
    ]);
    expect(result[0].description).toBe('ok');
    expect(recording.calls[0].model).toBe('vision-model');
  });

  it('breadth step honors broker precedence, not config insertion order', async () => {
    // A lower-precedence (non-ollama) provider is declared FIRST in config,
    // but the higher-precedence ollama provider must win the breadth fallback.
    const ollamaRecording = makeRecordingDriver('ollama');
    const remoteRecording = makeRecordingDriver('openrouter');
    const { capability } = await setupBroker({
      providers: {
        openrouter: {
          protocol: 'openrouter',
          models: { 'remote-vision': { hasVision: true } },
        },
        ollama: {
          protocol: 'ollama',
          models: {
            'local-text': {},
            'local-vision': { hasVision: true },
          },
        },
      },
      // Active model is non-vision so the D8 chain falls through to breadth.
      llmActive: 'ollama/local-text',
      drivers: {
        ollama: ollamaRecording.driver,
        openrouter: remoteRecording.driver,
      },
    });
    const result = await capability.describeImages([
      { mimeType: 'image/png', data: 'abc' },
    ]);
    expect(result[0].description).toBe('ok');
    // ollama (precedence 0) must be chosen over openrouter (precedence 1),
    // even though openrouter is declared first in config.
    expect(ollamaRecording.calls).toHaveLength(1);
    expect(remoteRecording.calls).toHaveLength(0);
    expect(ollamaRecording.calls[0].model).toBe('local-vision');
  });

  it('warns once and skips when no vision-capable model is available', async () => {
    const warnings: string[] = [];
    const logger: DroneLogger = {
      info: () => {},
      warn: m => warnings.push(String(m)),
      error: () => {},
    };
    const { capability } = await setupBroker({
      providers: {
        ollama: {
          protocol: 'ollama',
          models: { 'llama3.1': {} },
        },
      },
      llmActive: 'ollama/llama3.1',
      logger,
    });
    const images = [{ mimeType: 'image/png', data: 'abc' }];
    const result = await capability.describeImages(images);
    expect(result).toEqual(images);
    expect(result[0].description).toBeUndefined();
    await capability.describeImages(images);
    expect(warnings).toHaveLength(1);
  });

  it('skips already-described images', async () => {
    const recording = makeRecordingDriver('ollama');
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/llama3.1',
      drivers: { ollama: recording.driver },
    });
    const result = await capability.describeImages([
      { mimeType: 'image/png', data: 'abc', description: 'already described' },
    ]);
    expect(result[0].description).toBe('already described');
    expect(recording.calls).toHaveLength(0);
  });

  it('fails open and is idempotent on describer failure', async () => {
    const driver: LlmProtocolDriver = {
      protocolId: 'ollama',
      createProvider: () => ({
        chat: async () => {
          throw new Error('describer failed');
        },
      }),
      parameterSchema: { parameters: {} },
    };
    const { capability } = await setupBroker({
      providers: baseProviders,
      llmActive: 'ollama/llama3.1',
      drivers: { ollama: driver },
    });
    const images = [{ mimeType: 'image/png', data: 'abc' }];
    const result = await capability.describeImages(images);
    expect(result).toEqual(images);
    expect(result[0].description).toBeUndefined();
  });
});

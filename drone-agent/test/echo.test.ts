import { describe, expect, it } from 'vitest';
import type {
  DroneLlmCapability,
  DroneLlmProviderRegistration,
  DronePluginRegistration,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { echoPlugin } from '../src/plugins/echo/index.js';
import { silentLogger } from './helpers.js';

function createMockRegistration(): {
  registration: DronePluginRegistration;
  getRegisteredProvider: () => DroneLlmProviderRegistration | undefined;
} {
  const holder: { provider?: DroneLlmProviderRegistration } = {};
  const llmCapability: DroneLlmCapability = {
    getActiveProvider: () => {
      throw new Error('not used in test');
    },
    getActiveProviderId: () => 'echo',
    getAvailableProviders: () => [],
    activateProvider: () => {},
    getModel: () => 'echo-model',
    setModel: () => {},
    getReasoningLevel: () => undefined,
    setReasoningLevel: () => {},
    listModels: async () => [],
    registerProvider: registration => {
      holder.provider = registration;
    },
    unregisterProvider: () => {},
  };

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onShutdown: () => {},
      onSessionClear: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: <T>(pluginId: string) => {
      if (pluginId === 'llm') {
        return llmCapability as unknown as T;
      }
      return undefined;
    },
    runWorkflow: async () => ({}),
    requestElicitation: () => undefined,
    mountTool: () => undefined,
    unmountTool: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    listMountedTools: () => [],
  };
  return {
    registration,
    getRegisteredProvider: () => holder.provider,
  };
}

describe('echoPlugin', () => {
  it('registers a provider with the LLM broker', async () => {
    const { registration, getRegisteredProvider } = createMockRegistration();
    await echoPlugin.register(registration);
    const provider = getRegisteredProvider();
    expect(provider).toBeDefined();
    expect(provider?.id).toBe('echo');
    expect(provider?.getDefaultModel()).toBe('echo-model');
  });

  it('reports a context window large enough for the system prompt', async () => {
    const { registration, getRegisteredProvider } = createMockRegistration();
    await echoPlugin.register(registration);
    const provider = getRegisteredProvider()!.getProvider();
    const info = await provider.getContextWindowInfo?.({ model: 'echo-model' });
    expect(info).toBeDefined();
    // Must be at least the config default so the safety-trim budget doesn't
    // trip on the system prompt alone (responseReserveTokens is 4096).
    expect(info!.contextWindowTokens).toBeGreaterThanOrEqual(32768);
  });
});

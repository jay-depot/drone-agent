import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DroneConversationEvent,
  DroneLlmCapability,
  DroneLlmProviderRegistration,
  DronePluginRegistration,
  DroneSessionSafetyTrimPayload,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { anthropicPlugin } from '../src/plugins/anthropic/index.js';
import { silentLogger } from './helpers.js';

type HookBucket = {
  onPluginsLoaded: Array<() => Promise<void>>;
  onSessionStart: Array<() => Promise<void>>;
  onBeforePrompt: Array<() => Promise<void>>;
  onAfterToolCall: Array<() => Promise<void>>;
  onConversationEvent: Array<(event: DroneConversationEvent) => Promise<void>>;
  onSessionClear: Array<() => Promise<void>>;
  onShutdown: Array<() => Promise<void>>;
  onSessionSafetyTrimWillRun: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  >;
  onSessionSafetyTrimApplied: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  >;
};

function createRegistrationCapture() {
  const config = createDefaultAgentConfig();
  const hooks: HookBucket = {
    onPluginsLoaded: [],
    onSessionStart: [],
    onBeforePrompt: [],
    onAfterToolCall: [],
    onConversationEvent: [],
    onSessionClear: [],
    onShutdown: [],
    onSessionSafetyTrimWillRun: [],
    onSessionSafetyTrimApplied: [],
  };

  let registeredProvider: DroneLlmProviderRegistration | undefined;
  const llmCap: DroneLlmCapability = {
    registerProvider: provider => {
      registeredProvider = provider;
    },
    unregisterProvider: () => {},
    getActiveProvider: () => ({
      chat: async () => ({ message: 'ok' }),
      getContextWindowInfo: async () => null,
    }),
    getActiveProviderId: () => 'anthropic',
    getAvailableProviders: () => [{ id: 'anthropic', precedence: 1000 }],
    activateProvider: () => {},
    getModel: () => 'claude-sonnet-4-6',
    setModel: () => {},
    getReasoningLevel: () => undefined,
    setReasoningLevel: (_level: any) => {},
    listModels: async () => {
      const provider = registeredProvider;
      if (!provider) {
        return [];
      }
      return provider.listModels();
    },
  };

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => config,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    unregisterPluginTools: () => {},
    hooks: {
      onPluginsLoaded: cb => hooks.onPluginsLoaded.push(cb),
      onSessionStart: cb => hooks.onSessionStart.push(cb),
      onBeforePrompt: cb => hooks.onBeforePrompt.push(cb),
      onAfterToolCall: cb => hooks.onAfterToolCall.push(cb),
      onConversationEvent: cb => hooks.onConversationEvent.push(cb),
      onSessionClear: cb => hooks.onSessionClear.push(cb),
      onShutdown: cb => hooks.onShutdown.push(cb),
      onSessionSafetyTrimWillRun: cb =>
        hooks.onSessionSafetyTrimWillRun.push(cb),
      onSessionSafetyTrimApplied: cb =>
        hooks.onSessionSafetyTrimApplied.push(cb),
    },
    offer: () => {},
    request: <T>(id: string) =>
      (id === 'llm' ? (llmCap as T) : undefined) as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };

  return {
    config,
    registration,
    getRegisteredProvider: () => registeredProvider,
  };
}

describe('anthropic plugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers with llm broker and exposes configured models', async () => {
    const capture = createRegistrationCapture();
    capture.config.anthropic.models = [
      { id: 'claude-haiku-4-5', contextWindow: 200000 },
      { id: 'claude-sonnet-4-6', contextWindow: 1000000 },
      { id: 'claude-opus-4-8', contextWindow: 1000000 },
    ];
    capture.config.anthropic.defaultModel = 'claude-sonnet-4-6';

    await anthropicPlugin.register(capture.registration);

    const providerReg = capture.getRegisteredProvider();
    expect(providerReg).toBeDefined();
    expect(providerReg?.id).toBe('anthropic');
    await expect(providerReg?.listModels()).resolves.toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-8',
    ]);
    expect(providerReg?.getDefaultModel()).toBe('claude-sonnet-4-6');
  });

  it('errors clearly when api key is missing', async () => {
    const capture = createRegistrationCapture();
    capture.config.anthropic.apiKey = '';

    await anthropicPlugin.register(capture.registration);
    const providerReg = capture.getRegisteredProvider();
    expect(providerReg).toBeDefined();

    const provider = providerReg!.getProvider();
    await expect(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
      })
    ).rejects.toThrow('Anthropic API key is not configured');
  });

  it('maps tool_use from Anthropic response and sends required headers', async () => {
    const capture = createRegistrationCapture();
    capture.config.anthropic.apiKey = 'test-anthropic-key';
    capture.config.anthropic.baseUrl = 'https://api.anthropic.com';
    capture.config.anthropic.apiVersion = '2023-06-01';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'msg_123',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_abc',
              name: 'file__read',
              input: { path: 'README.md' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await anthropicPlugin.register(capture.registration);
    const provider = capture.getRegisteredProvider()!.getProvider();

    const response = await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Read the README' }],
      tools: [
        {
          name: 'file__read',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers?: Record<string, string> },
    ];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers?.['x-api-key']).toBe('test-anthropic-key');
    expect(init.headers?.['anthropic-version']).toBe('2023-06-01');

    expect(response.toolCalls).toEqual([
      {
        id: 'toolu_abc',
        name: 'file__read',
        arguments: { path: 'README.md' },
      },
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DroneConversationEvent,
  DroneLlmCapability,
  DroneLlmProviderRegistration,
  DronePluginRegistration,
  DroneSessionSafetyTrimPayload,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { openaiPlugin } from '../src/plugins/openai/index.js';
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
    getActiveProviderId: () => 'openai',
    getAvailableProviders: () => [{ id: 'openai', precedence: 1000 }],
    activateProvider: () => {},
    getModel: () => 'gpt-4o',
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

describe('openai plugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers with llm broker and exposes configured models', async () => {
    const capture = createRegistrationCapture();
    capture.config.openai.models = [
      { id: 'gpt-4o', contextWindow: 128000 },
      { id: 'gpt-4.1', contextWindow: 1047576 },
    ];
    capture.config.openai.defaultModel = 'gpt-4o';

    await openaiPlugin.register(capture.registration);

    const providerReg = capture.getRegisteredProvider();
    expect(providerReg).toBeDefined();
    expect(providerReg?.id).toBe('openai');
    await expect(providerReg?.listModels()).resolves.toEqual([
      'gpt-4o',
      'gpt-4.1',
    ]);
    expect(providerReg?.getDefaultModel()).toBe('gpt-4o');
  });

  it('errors clearly when api key is missing', async () => {
    const capture = createRegistrationCapture();
    capture.config.openai.apiKey = '';

    await openaiPlugin.register(capture.registration);
    const providerReg = capture.getRegisteredProvider();
    expect(providerReg).toBeDefined();

    const provider = providerReg!.getProvider();
    await expect(
      provider.chat({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      })
    ).rejects.toThrow('OpenAI API key is not configured');
  });

  it('maps tool calls from OpenAI response and sends org header when configured', async () => {
    const capture = createRegistrationCapture();
    capture.config.openai.apiKey = 'test-key';
    capture.config.openai.orgId = 'org-test';
    capture.config.openai.baseUrl = 'https://api.openai.com/v1';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_1',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_abc123',
                    type: 'function',
                    function: {
                      name: 'file__read',
                      arguments: '{"path":"README.md"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await openaiPlugin.register(capture.registration);
    const provider = capture.getRegisteredProvider()!.getProvider();

    const response = await provider.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Read file' }],
      tools: [
        {
          name: 'file__read',
          description: 'Read file',
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
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers?.Authorization).toBe('Bearer test-key');
    expect(init.headers?.['OpenAI-Organization']).toBe('org-test');

    expect(response.toolCalls).toEqual([
      {
        id: 'call_abc123',
        name: 'file__read',
        arguments: { path: 'README.md' },
      },
    ]);
  });

  it('passes canonical mcp tool names through unchanged', async () => {
    const capture = createRegistrationCapture();
    capture.config.openai.apiKey = 'test-key';
    capture.config.openai.baseUrl = 'https://api.openai.com/v1';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_2',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_mcp_1',
                    type: 'function',
                    function: {
                      name: 'mcp__github__list_resources',
                      arguments: '{}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await openaiPlugin.register(capture.registration);
    const provider = capture.getRegisteredProvider()!.getProvider();

    const response = await provider.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'List resources' }],
      tools: [
        {
          name: 'mcp__github__list_resources',
          description: 'List resources',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { body?: string },
    ];
    const body = JSON.parse(init.body ?? '{}') as {
      tools: Array<{ function: { name: string } }>;
    };
    expect(body.tools[0]?.function.name).toBe('mcp__github__list_resources');

    expect(response.toolCalls).toEqual([
      {
        id: 'call_mcp_1',
        name: 'mcp__github__list_resources',
        arguments: {},
      },
    ]);
  });
});

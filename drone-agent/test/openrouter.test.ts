import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DroneConversationEvent,
  DroneLlmCapability,
  DroneLlmProviderRegistration,
  DronePluginRegistration,
  DroneSessionSafetyTrimPayload,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { openrouterPlugin } from '../src/plugins/openrouter/index.js';
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
    getActiveProviderId: () => 'openrouter',
    getAvailableProviders: () => [{ id: 'openrouter', precedence: 1000 }],
    activateProvider: () => {},
    getModel: () => 'openai/gpt-4o',
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
    unregisterTool: () => {},
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

describe('openrouter plugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retries once with provider hints on tool-routing 404', async () => {
    const capture = createRegistrationCapture();
    capture.config.openrouter.apiKey = 'test-openrouter-key';
    capture.config.openrouter.baseUrl = 'https://openrouter.ai/api/v1';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                'No endpoints found that support tool use. Try disabling "notepad__notepad__set".',
              code: 404,
            },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
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
        )
      );

    vi.stubGlobal('fetch', fetchMock);

    await openrouterPlugin.register(capture.registration);
    const provider = capture.getRegisteredProvider()!.getProvider();

    const response = await provider.chat({
      model: 'openai/gpt-4o',
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

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstBody = JSON.parse(firstInit.body as string) as {
      provider?: Record<string, unknown>;
      tools?: unknown[];
    };
    expect(firstBody.tools?.length).toBe(1);
    expect(firstBody.provider).toBeUndefined();

    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondBody = JSON.parse(secondInit.body as string) as {
      provider?: { require_parameters?: boolean };
      tools?: unknown[];
    };
    expect(secondBody.tools?.length).toBe(1);
    expect(secondBody.provider?.require_parameters).toBe(true);

    expect(response.toolCalls).toEqual([
      {
        id: 'call_abc123',
        name: 'file__read',
        arguments: { path: 'README.md' },
      },
    ]);
  });

  it('does not retry for non-routing errors', async () => {
    const capture = createRegistrationCapture();
    capture.config.openrouter.apiKey = 'test-openrouter-key';
    capture.config.openrouter.baseUrl = 'https://openrouter.ai/api/v1';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'rate limit exceeded',
            code: 429,
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )
    );

    vi.stubGlobal('fetch', fetchMock);

    await openrouterPlugin.register(capture.registration);
    const provider = capture.getRegisteredProvider()!.getProvider();

    await expect(
      provider.chat({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
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
            },
          },
        ],
      })
    ).rejects.toThrow('OpenRouter API error (429)');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes canonical mcp tool names through unchanged', async () => {
    const capture = createRegistrationCapture();
    capture.config.openrouter.apiKey = 'test-openrouter-key';
    capture.config.openrouter.baseUrl = 'https://openrouter.ai/api/v1';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
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
      )
    );

    vi.stubGlobal('fetch', fetchMock);

    await openrouterPlugin.register(capture.registration);
    const provider = capture.getRegisteredProvider()!.getProvider();

    const response = await provider.chat({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'List MCP resources' }],
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
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

  it('extracts reasoning from response when choice.reasoning is present', async () => {
    const capture = createRegistrationCapture();
    capture.config.openrouter.apiKey = 'test-openrouter-key';
    capture.config.openrouter.baseUrl = 'https://openrouter.ai/api/v1';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl_10',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Final answer' },
              reasoning: 'Deep reasoning chain here',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await openrouterPlugin.register(capture.registration);
    const provider = capture.getRegisteredProvider()!.getProvider();

    const response = await provider.chat({
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'think step by step' }],
    });

    expect(response.reasoning).toBe('Deep reasoning chain here');
    expect(response.message).toBe('Final answer');
  });
});

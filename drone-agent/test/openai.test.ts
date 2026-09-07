import { afterEach, describe, expect, it, vi } from 'vitest';
import { DroneLlmError, createDefaultAgentConfig } from 'drone-core';
import type {
  DroneConversationEvent,
  DroneLlmCapability,
  DronePluginRegistration,
  DroneSessionSafetyTrimPayload,
} from 'drone-core';
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

  let registeredDriver: import('drone-core').LlmProtocolDriver | undefined;
  const llmCap: DroneLlmCapability = {
    registerDriver: driver => {
      registeredDriver = driver;
    },
    registerProvider: () => {},
    unregisterProvider: () => {},
    getActiveProvider: () => ({
      chat: async () => ({ message: 'ok' }),
      getContextWindowInfo: async () => null,
    }),
    resolveModelForRole: () => ({
      provider: { chat: async () => ({ message: 'ok' }) },
      providerId: 'openai',
      model: 'gpt-4o',
    }),
    getActiveProviderId: () => 'openai',
    getAvailableProviders: () => [{ id: 'openai', precedence: 1000 }],
    activateProvider: () => {},
    getModel: () => 'gpt-4o',
    setModel: () => {},
    getReasoningLevel: () => undefined,
    setReasoningLevel: (_level: unknown) => {},
    listModels: async () => {
      return [];
    },
    describeImages: async images => images,
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
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    emitEvent: () => {},
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
    getRegisteredDriver: () => registeredDriver,
    getProviderViaDriver: () => {
      const driver = registeredDriver;
      if (!driver) throw new Error('driver not registered');
      return driver.createProvider({
        protocol: 'openai',
        baseUrl: config.openai.baseUrl,
        apiKey: config.openai.apiKey,
        orgId: config.openai.orgId,
      });
    },
  };
}

describe('openai plugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers its driver with the llm broker', async () => {
    const capture = createRegistrationCapture();

    await openaiPlugin.register(capture.registration);

    expect(capture.getRegisteredDriver()).toBeDefined();
  });

  it('errors clearly when api key is missing', async () => {
    const capture = createRegistrationCapture();

    await openaiPlugin.register(capture.registration);
    const provider = capture.getProviderViaDriver();
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
    const provider = capture.getProviderViaDriver();

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
    const provider = capture.getProviderViaDriver();

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

  it('sends reasoning_effort in request when reasoningLevel is provided', async () => {
    const capture = createRegistrationCapture();
    capture.config.openai.apiKey = 'test-key';
    capture.config.openai.baseUrl = 'https://api.openai.com/v1';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_3',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Hello' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await openaiPlugin.register(capture.registration);
    const provider = capture.getProviderViaDriver();

    await provider.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningLevel: 'high',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { body?: string },
    ];
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('high');
  });

  it('extracts reasoning from response when choice.reasoning is present', async () => {
    const capture = createRegistrationCapture();
    capture.config.openai.apiKey = 'test-key';
    capture.config.openai.baseUrl = 'https://api.openai.com/v1';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_4',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Final answer' },
              reasoning: 'Step-by-step reasoning here',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await openaiPlugin.register(capture.registration);
    const provider = capture.getProviderViaDriver();

    const response = await provider.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'think step by step' }],
    });

    expect(response.reasoning).toBe('Step-by-step reasoning here');
    expect(response.message).toBe('Final answer');
  });

  it('does not set reasoning when choice.reasoning is absent', async () => {
    const capture = createRegistrationCapture();
    capture.config.openai.apiKey = 'test-key';
    capture.config.openai.baseUrl = 'https://api.openai.com/v1';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_5',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'No reasoning' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await openaiPlugin.register(capture.registration);
    const provider = capture.getProviderViaDriver();

    const response = await provider.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(response.reasoning).toBeUndefined();
    expect(response.message).toBe('No reasoning');
  });

  it('extracts reasoning from message.reasoning when choice.reasoning is absent', async () => {
    const capture = createRegistrationCapture();
    capture.config.openai.apiKey = 'test-key';
    capture.config.openai.baseUrl = 'https://api.openai.com/v1';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_6',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Final answer',
                reasoning: 'Step-by-step reasoning inside message',
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await openaiPlugin.register(capture.registration);
    const provider = capture.getProviderViaDriver();

    const response = await provider.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'think step by step' }],
    });

    expect(response.reasoning).toBe('Step-by-step reasoning inside message');
    expect(response.message).toBe('Final answer');
  });

  it('throws DroneLlmError with status/retryAfter/retryable for a 429', async () => {
    const capture = createRegistrationCapture();
    capture.config.openai.apiKey = 'test-key';
    capture.config.openai.baseUrl = 'https://api.openai.com/v1';

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { message: 'rate limited' } }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '2',
          },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await openaiPlugin.register(capture.registration);
    const provider = capture.getProviderViaDriver();

    const err = await provider
      .chat({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      })
      .then(
        () => null,
        e => e
      );

    expect(err).toBeInstanceOf(DroneLlmError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.retryable).toBe(true);
  });
});

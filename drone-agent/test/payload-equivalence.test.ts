import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DroneLlmCapability,
  DroneLlmProvider,
  DronePlugin,
  LlmProtocolDriver,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { openaiPlugin } from '../src/plugins/openai/index.js';
import { anthropicPlugin } from '../src/plugins/anthropic/index.js';
import { silentLogger } from './helpers.js';

/**
 * Payload-equivalence gate (plan validation criterion 6): a migrated
 * providers config must produce wire requests identical to the legacy
 * section-driven plugins, except the documented anthropic max_tokens delta.
 */

function captureDriver(
  plugin: DronePlugin,
  protocol: string,
  providerConfig: Record<string, unknown>
): Promise<DroneLlmProvider> {
  let driver: LlmProtocolDriver | undefined;
  const llmCap: DroneLlmCapability = {
    registerDriver: (d: LlmProtocolDriver) => {
      driver = d;
    },
  } as unknown as DroneLlmCapability;
  const registration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    offer: () => {},
    request: <T>(id: string) =>
      (id === 'llm' ? (llmCap as T) : undefined) as T | undefined,
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
    runWorkflow: async () => ({}),
    requestElicitation: () => undefined,
  };
  return (async () => {
    await plugin.register(registration);
    if (!driver) throw new Error('driver not registered');
    return driver.createProvider({
      protocol,
      ...providerConfig,
    } as never);
  })();
}

const MESSAGES = [
  { role: 'system', content: 'be brief' },
  { role: 'user', content: 'hello' },
] as const;

const TOOLS = [
  {
    name: 'file__read',
    description: 'Read a file',
    inputSchema: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'] as string[],
      additionalProperties: false,
    },
  },
] as const;

describe('payload equivalence: legacy sections vs migrated providers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('openai: identical request body and headers', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'x',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'hi' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = await captureDriver(openaiPlugin, 'openai', {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      orgId: 'org-test',
    });

    await provider.chat({
      model: 'gpt-4o',
      messages: [...MESSAGES],
      tools: [...TOOLS],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // Legacy plugin sent exactly: model, messages, tools (no reasoning).
    expect(body).toEqual({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'file__read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        },
      ],
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['OpenAI-Organization']).toBe('org-test');
  });

  it('anthropic: identical except documented max_tokens delta', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'm',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = await captureDriver(anthropicPlugin, 'anthropic', {
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      apiVersion: '2023-06-01',
    });

    await provider.chat({
      model: 'claude-sonnet-4-6',
      messages: [...MESSAGES],
      tools: [...TOOLS],
      // Broker resolves maxOutputTokens metadata; legacy borrowed
      // session.responseReserveTokens (default 4096).
      maxOutputTokens: 4096,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'claude-sonnet-4-6',
      // Legacy wire value was also 4096 via responseReserveTokens —
      // equivalence holds when maxOutputTokens matches that value.
      max_tokens: 4096,
      system: 'be brief',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
      tools: [
        {
          name: 'file__read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('openai: reasoning_effort maps off→minimal (documented delta from legacy none)', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'x',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'hi' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = await captureDriver(openaiPlugin, 'openai', {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
    });

    await provider.chat({
      model: 'gpt-4o',
      messages: [...MESSAGES],
      reasoningLevel: 'off',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('minimal');
  });
});

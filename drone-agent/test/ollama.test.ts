import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ShowResponse } from 'ollama';
import {
  createOllamaProvider,
  discoverOllamaModels,
  extractContextWindowTokens,
  isCloudModel,
  OLLAMA_LOCAL_NUM_CTX_PIN,
  parseModelfileNumCtx,
} from '../src/plugins/ollama/driver.js';

function makeShowResponse(
  modelInfo: Record<string, unknown> | Map<string, unknown>
): ShowResponse {
  return {
    model_info: modelInfo as unknown as ShowResponse['model_info'],
  } as ShowResponse;
}

describe('extractContextWindowTokens', () => {
  it('reads general.context_length when present', () => {
    const show = makeShowResponse({ 'general.context_length': 32768 });
    expect(extractContextWindowTokens(show)).toBe(32768);
  });

  it('reads llama.context_length when general is absent', () => {
    const show = makeShowResponse({
      'llama.context_length': 8192,
      'general.architecture': 'llama',
    });
    expect(extractContextWindowTokens(show)).toBe(8192);
  });

  it('prefers the architecture-specific context_length over general', () => {
    // Mirrors deepseek4 (1M tokens) overriding a smaller generic default.
    const show = makeShowResponse({
      'general.context_length': 4096,
      'deepseek4.context_length': 1048576,
      'general.architecture': 'deepseek4',
    });
    expect(extractContextWindowTokens(show)).toBe(1048576);
  });

  it('falls back to scanning for any <arch>.context_length entry', () => {
    // Architecture we have never seen: parser should still find it.
    const show = makeShowResponse({
      'foo42.context_length': 65536,
    });
    expect(extractContextWindowTokens(show)).toBe(65536);
  });

  it('parses string-encoded numbers', () => {
    const show = makeShowResponse({
      'general.context_length': '16384',
    });
    expect(extractContextWindowTokens(show)).toBe(16384);
  });

  it('ignores non-positive values', () => {
    const show = makeShowResponse({
      'general.context_length': 0,
      'llama.context_length': -1,
      'qwen2.context_length': 'abc',
    });
    expect(extractContextWindowTokens(show)).toBeNull();
  });

  it('returns null when no context_length is present', () => {
    const show = makeShowResponse({
      'general.architecture': 'llama',
      'llama.embedding_length': 4096,
    });
    expect(extractContextWindowTokens(show)).toBeNull();
  });

  it('handles Map-shaped model_info responses', () => {
    const info = new Map<string, unknown>([
      ['general.architecture', 'deepseek4'],
      ['deepseek4.context_length', 1048576],
    ]);
    const show = makeShowResponse(info);
    expect(extractContextWindowTokens(show)).toBe(1048576);
  });

  it('returns null when model_info is missing entirely', () => {
    const show = { model_info: undefined } as unknown as ShowResponse;
    expect(extractContextWindowTokens(show)).toBeNull();
  });
});

describe('ollama chat user-message injection', () => {
  let chatCalls: Array<{ model: string; messages: unknown[] }>;

  beforeEach(() => {
    chatCalls = [];
    vi.resetModules();
    vi.doMock('ollama', () => ({
      Ollama: vi.fn().mockImplementation(() => ({
        chat: vi.fn(
          async ({
            model,
            messages,
          }: {
            model: string;
            messages: unknown[];
          }) => {
            chatCalls.push({ model, messages });
            return { message: { content: 'ok', thinking: '' } };
          }
        ),
        show: vi.fn(async () => ({
          model_info: { 'general.context_length': 4096 },
        })),
        list: vi.fn(async () => ({ models: [] })),
      })),
      ShowResponse: class {},
      ToolCall: class {},
    }));
  });

  async function captureProvider() {
    const { ollamaPlugin } = await import('../src/plugins/ollama/index.js');
    let driver: import('drone-core').LlmProtocolDriver | undefined;
    await ollamaPlugin.register({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getConfig: () => ({
        ollama: { host: 'http://localhost:11434', model: 'fake' },
        session: { contextWindowTokens: 4096 },
      }),
      registerTool: () => {},
      registerPromptFragment: () => {},
      registerHelp: () => {},
      registerSlashCommand: () => {},
      registerWorkflow: () => {},
      unregisterPluginTools: () => {},
      unregisterTool: () => {},
      mountTool: () => undefined,
      unmountTool: () => {},
      listMountedTools: () => [],
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
      offer: (cap: unknown) => {
        driver = (cap as { driver: import('drone-core').LlmProtocolDriver })
          .driver;
      },
      request: () => undefined,
      runWorkflow: async () => ({ toolResult: '{}' }),
      requestElicitation: () => undefined,
    } as never);
    if (!driver) {
      throw new Error('driver not offered');
    }
    return driver.createProvider({
      protocol: 'ollama',
      baseUrl: 'http://localhost:11434',
    });
  }

  it('prepends a placeholder user message when no user role is present', async () => {
    const provider = await captureProvider();
    await provider.chat({
      model: 'fake',
      messages: [
        { role: 'system', content: 'greet the user' },
        { role: 'assistant', content: 'hi' },
      ],
    });

    expect(chatCalls).toHaveLength(1);
    const sent = chatCalls[0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(sent[0]).toEqual({
      role: 'user',
      content: '(Continuing from summaries)',
    });
    expect(sent.map(m => m.role)).toEqual(['user', 'system', 'assistant']);
  });

  it('does not inject a placeholder when a user message already exists', async () => {
    const provider = await captureProvider();
    await provider.chat({
      model: 'fake',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });

    expect(chatCalls).toHaveLength(1);
    const sent = chatCalls[0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(sent.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(sent[0]).not.toHaveProperty(
      'content',
      '(Continuing from summaries)'
    );
  });
});
const LOCAL_SHOW = {
  modelfile: '# Modelfile generated by "ollama show"\nFROM blob',
  parameters: 'num_ctx 8192',
  model_info: { 'general.context_length': 2048 },
};

const CLOUD_SHOW = {
  modelfile: '',
  parameters: '',
  model_info: { 'deepseek4.context_length': 1048576 },
};

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    show: vi.fn(async () => LOCAL_SHOW),
    ps: vi.fn(async () => ({ models: [] })),
    chat: vi.fn(),
    list: vi.fn(async () => ({ models: [] })),
    ...overrides,
  };
}

async function buildProviderWithClient(client: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('ollama', () => ({
    Ollama: vi.fn().mockImplementation(() => client),
    ShowResponse: class {},
    ToolCall: class {},
  }));
  const module = await import('../src/plugins/ollama/driver.js');
  const warns: string[] = [];
  const provider = (
    module as typeof import('../src/plugins/ollama/driver.js')
  ).createOllamaProvider({
    baseUrl: 'http://localhost:11434',
    logger: {
      info: () => {},
      warn: (msg: string) => warns.push(msg),
      error: () => {},
    },
  });
  return { provider, client, warns };
}

describe('parseModelfileNumCtx', () => {
  it('parses a single num_ctx directive with aligned whitespace', () => {
    expect(parseModelfileNumCtx('num_ctx                        8192')).toBe(
      8192
    );
  });

  it('parses among multiple directives', () => {
    expect(
      parseModelfileNumCtx('temperature 0.7\nnum_ctx 4096\ntop_p 0.9')
    ).toBe(4096);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseModelfileNumCtx('  NUM_CTX   2048  ')).toBe(2048);
  });

  it('returns null when num_ctx is absent or malformed', () => {
    expect(parseModelfileNumCtx('temperature 0.7')).toBeNull();
    expect(parseModelfileNumCtx('')).toBeNull();
    expect(parseModelfileNumCtx(undefined)).toBeNull();
    expect(parseModelfileNumCtx(null as unknown as string)).toBeNull();
    expect(parseModelfileNumCtx('num_ctx 0')).toBeNull();
  });
});

describe('isCloudModel', () => {
  it('detects locals by presence of a modelfile', () => {
    expect(isCloudModel(LOCAL_SHOW, 'llama3.1')).toBe(false);
  });

  it('detects locals with parameters even without a modelfile', () => {
    expect(
      isCloudModel({ modelfile: '', parameters: 'num_ctx 8192' }, 'm')
    ).toBe(false);
  });

  it('detects cloud models by absence of both local artifacts', () => {
    expect(isCloudModel({ modelfile: '', parameters: '' }, 'm:cloud')).toBe(
      true
    );
  });

  it('detects :cloud and -cloud suffixes regardless of other fields', () => {
    expect(isCloudModel(LOCAL_SHOW, 'deepseek-v4-flash:cloud')).toBe(true);
    expect(isCloudModel(LOCAL_SHOW, 'deepseek-v4-flash:0731-cloud')).toBe(true);
  });
});

describe('local model context-window precedence', () => {
  it('pin is 16384', () => {
    expect(OLLAMA_LOCAL_NUM_CTX_PIN).toBe(16384);
  });

  it('unconstrained local falls back to the driver pin', async () => {
    const client = makeClient({
      show: vi.fn(async () => ({ ...LOCAL_SHOW, parameters: '' })),
    });
    const { provider } = await buildProviderWithClient(client);
    const info = await provider.getContextWindowInfo!({ model: 'llama3.1' });
    expect(info).toMatchObject({
      contextWindowTokens: OLLAMA_LOCAL_NUM_CTX_PIN,
      source: 'provider',
      detail: `driver pin ${OLLAMA_LOCAL_NUM_CTX_PIN}`,
    });
  });

  it('modelfile num_ctx outranks the pin', async () => {
    const { provider } = await buildProviderWithClient(makeClient());
    const info = await provider.getContextWindowInfo!({ model: 'nomic' });
    expect(info).toMatchObject({
      contextWindowTokens: 8192,
      detail: 'modelfile num_ctx',
    });
  });

  it('request num_ctx outranks the modelfile', async () => {
    const { provider } = await buildProviderWithClient(makeClient());
    const info = await provider.getContextWindowInfo!({
      model: 'nomic',
      parameters: { numCtx: 32768 },
    });
    expect(info).toMatchObject({
      contextWindowTokens: 32768,
      detail: 'request num_ctx',
    });
  });

  it('extra.num_ctx reaches the same resolution slot as parameters.numCtx', async () => {
    const { provider } = await buildProviderWithClient(makeClient());
    const info = await provider.getContextWindowInfo!({
      model: 'nomic',
      extra: { num_ctx: 65536 },
    });
    expect(info).toMatchObject({
      contextWindowTokens: 65536,
      detail: 'request num_ctx',
    });
  });

  it('resident ps entry outranks the request value (enforcement truth)', async () => {
    const client = makeClient({
      ps: vi.fn(async () => ({
        models: [{ name: 'nomic', model: 'nomic', context_length: 2048 }],
      })),
    });
    const { provider } = await buildProviderWithClient(client);
    const info = await provider.getContextWindowInfo!({
      model: 'nomic',
      parameters: { numCtx: 32768 },
    });
    expect(info).toMatchObject({
      contextWindowTokens: 2048,
      detail: 'ps-resident',
    });
  });

  it('warns once when resolution exceeds the advertised training length', async () => {
    const client = makeClient();
    const { provider, warns } = await buildProviderWithClient(client);
    await provider.getContextWindowInfo!({
      model: 'ropey',
      parameters: { numCtx: 32768 },
    });
    await provider.getContextWindowInfo!({
      model: 'ropey',
      parameters: { numCtx: 32768 },
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('exceeds the advertised training length');
  });

  it('never warns when resolution is within the advertised length', async () => {
    const client = makeClient({
      show: vi.fn(async () => ({
        ...LOCAL_SHOW,
        model_info: { 'general.context_length': 131072 },
      })),
    });
    const { provider, warns } = await buildProviderWithClient(client);
    await provider.getContextWindowInfo!({ model: 'calm' });
    expect(warns).toHaveLength(0);
  });

  it('cloud models report the advertised length without consulting local slots', async () => {
    const client = makeClient({ show: vi.fn(async () => CLOUD_SHOW) });
    const { provider } = await buildProviderWithClient(client);
    const info = await provider.getContextWindowInfo!({
      model: 'x:cloud',
      parameters: { numCtx: 999 },
    });
    expect(info).toMatchObject({
      contextWindowTokens: 1048576,
      source: 'provider',
      detail: 'advertised (cloud)',
    });
  });

  it('falls back to source default when /api/show fails entirely', async () => {
    const client = makeClient({
      show: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    const { provider } = await buildProviderWithClient(client);
    const info = await provider.getContextWindowInfo!({ model: 'ghost' });
    expect(info?.source).toBe('default');
    expect(info?.contextWindowTokens).toBeGreaterThan(0);
  });

  it('ps failures degrade to the next slot instead of erroring', async () => {
    const client = makeClient({
      ps: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { provider } = await buildProviderWithClient(client);
    const info = await provider.getContextWindowInfo!({ model: 'nomic' });
    expect(info).toMatchObject({
      contextWindowTokens: 8192,
      detail: 'modelfile num_ctx',
    });
  });
});

describe('ollama discovery catalog policy', () => {
  afterEach(() => {
    vi.doUnmock('ollama');
    vi.restoreAllMocks();
  });

  it('publishes contextWindow ONLY for cloud models (A5 trap regression)', async () => {
    vi.resetModules();
    vi.doMock('ollama', () => ({
      Ollama: vi.fn().mockImplementation(() => ({
        list: vi.fn(async () => ({
          models: [
            { name: 'deepseek-v4-flash:cloud' },
            { name: 'nomic-embed-text:v1.5' },
          ],
        })),
        show: vi.fn(async ({ model }: { model: string }) =>
          model.includes('cloud') ? CLOUD_SHOW : LOCAL_SHOW
        ),
        chat: vi.fn(),
        ps: vi.fn(),
      })),
      ShowResponse: class {},
      ToolCall: class {},
    }));
    const module = await import('../src/plugins/ollama/driver.js');
    const discovered = await (
      module as typeof import('../src/plugins/ollama/driver.js')
    ).discoverOllamaModels('http://localhost:11434');

    const cloud = discovered.find(m => m.id === 'deepseek-v4-flash:cloud');
    const local = discovered.find(m => m.id === 'nomic-embed-text:v1.5');
    expect(cloud?.contextWindow).toBe(1048576);
    // The critical assertion: a local's training max must NEVER enter the
    // catalog — broker metadata outranks the probe, so it would mask the
    // runtime resolution forever.
    expect(local?.contextWindow).toBeUndefined();
    expect(local?.hasVision).toBeDefined();
    expect(local?.supportsTools).toBeDefined();
  });
});

describe('ollama DroneLlmError conversion', () => {
  async function captureProvider() {
    const { ollamaPlugin } = await import('../src/plugins/ollama/index.js');
    let driver: import('drone-core').LlmProtocolDriver | undefined;
    await ollamaPlugin.register({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getConfig: () => ({
        ollama: { host: 'http://localhost:11434', model: 'fake' },
        session: { contextWindowTokens: 4096 },
      }),
      registerTool: () => {},
      registerPromptFragment: () => {},
      registerHelp: () => {},
      registerSlashCommand: () => {},
      registerWorkflow: () => {},
      unregisterPluginTools: () => {},
      unregisterTool: () => {},
      mountTool: () => undefined,
      unmountTool: () => {},
      listMountedTools: () => [],
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
      offer: (cap: unknown) => {
        driver = (cap as { driver: import('drone-core').LlmProtocolDriver })
          .driver;
      },
      request: () => undefined,
      runWorkflow: async () => ({ toolResult: '{}' }),
      requestElicitation: () => undefined,
    } as never);
    if (!driver) {
      throw new Error('driver not offered');
    }
    return driver.createProvider({
      protocol: 'ollama',
      baseUrl: 'http://localhost:11434',
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('ollama', () => ({
      Ollama: vi.fn().mockImplementation(() => ({
        chat: vi.fn(async () => {
          const err = new Error('model "nope" not found, try pulling it first');
          (err as { status_code?: number }).status_code = 404;
          throw err;
        }),
        show: vi.fn(async () => ({
          model_info: { 'general.context_length': 4096 },
        })),
        list: vi.fn(async () => ({ models: [] })),
        ps: vi.fn(async () => ({ models: [] })),
      })),
      ShowResponse: class {},
      ToolCall: class {},
    }));
  });

  afterEach(() => {
    vi.unmock('ollama');
  });

  it('maps a not-found model to a 404 DroneLlmError with a pull hint', async () => {
    const provider = await captureProvider();
    const err = await provider
      .chat({
        model: 'nope',
        messages: [{ role: 'user', content: 'hello' }],
      })
      .then(
        () => null,
        e => e
      );

    expect(err?.name).toBe('DroneLlmError');
    expect(err.status).toBe(404);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('ollama pull nope');
  });

  it('marks transient ollama status codes retryable', async () => {
    vi.doMock('ollama', () => ({
      Ollama: vi.fn().mockImplementation(() => ({
        chat: vi.fn(async () => {
          const err = new Error('server overloaded');
          (err as { status_code?: number }).status_code = 503;
          throw err;
        }),
        show: vi.fn(async () => ({
          model_info: { 'general.context_length': 4096 },
        })),
        list: vi.fn(async () => ({ models: [] })),
        ps: vi.fn(async () => ({ models: [] })),
      })),
      ShowResponse: class {},
      ToolCall: class {},
    }));
    const provider = await captureProvider();
    const err = await provider
      .chat({
        model: 'nope',
        messages: [{ role: 'user', content: 'hello' }],
      })
      .then(
        () => null,
        e => e
      );

    expect(err?.name).toBe('DroneLlmError');
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });
});

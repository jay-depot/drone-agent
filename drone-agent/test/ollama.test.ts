import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ShowResponse } from 'ollama';
import { extractContextWindowTokens } from '../src/plugins/ollama/driver.js';

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

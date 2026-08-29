import { describe, expect, it, vi } from 'vitest';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import {
  DroneLlmError,
  createDefaultAgentConfig,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
} from 'drone-core';
import { createConversationService } from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import type { ContextBudgetService } from '../src/runtime/context-budget-service.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { createMockEngine, silentLogger } from './helpers.js';

type ChatImpl = (attempt: number) => Promise<DroneChatResponse>;

function makeProvider(
  chatImpl: ChatImpl
): DroneLlmProvider & { __chatMock: ReturnType<typeof vi.fn> } {
  let attempt = 0;
  const chatMock = vi.fn(async () => chatImpl(++attempt));
  return {
    chat: chatMock,
    getContextWindowInfo: async () =>
      ({
        model: 'fake',
        contextWindowTokens: 1_000_000,
        source: 'config',
      }) satisfies DroneContextWindowInfo,
    __chatMock: chatMock,
  };
}

function makeLlmCapability(provider: DroneLlmProvider): DroneLlmCapability {
  return {
    getActiveProvider: () => provider,
    resolveModelForRole: () => ({
      provider,
      providerId: 'test-provider',
      model: 'fake',
    }),
    getActiveProviderId: () => 'test-provider',
    getAvailableProviders: () => [{ id: 'test-provider', precedence: 1000 }],
    activateProvider: () => {},
    getModel: () => 'fake',
    setModel: () => {},
    getReasoningLevel: () => undefined,
    setReasoningLevel: (_level: unknown) => {},
    listModels: async () => ['fake'],
    registerDriver: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    describeImages: async images => images,
  };
}

function makeBudgetService(provider: DroneLlmProvider): ContextBudgetService {
  return createContextBudgetService({
    config: createDefaultAgentConfig(),
    renderPromptFragments: async () => [],
    getProvider: () => provider,
    getModel: () => 'fake',
  });
}

type Harness = {
  conversation: ReturnType<typeof createConversationService>;
  provider: ReturnType<typeof makeProvider>;
  events: Array<{ kind: string; message?: string; content?: string }>;
  send: (prompt: string) => Promise<string>;
};

async function setup(options: {
  chatImpl: ChatImpl;
  onRetryPrompt?: (error: DroneLlmError, attempt: number) => Promise<boolean>;
  retry?: Partial<{
    maxRetries: number;
    maxWaitMs: number;
    promptOnError: boolean;
    backoffBaseMs: number;
    backoffFactor: number;
  }>;
}): Promise<Harness> {
  const engine = createMockEngine({
    tools: [],
    executeToolImpl: async () => '',
  });
  const provider = makeProvider(options.chatImpl);
  const llm = makeLlmCapability(provider);
  const config = createDefaultAgentConfig();
  if (options.retry) {
    config.session.retry = options.retry;
  }
  const sessionManager = createSessionManager();
  const budgetService = makeBudgetService(provider);
  const conversation = createConversationService({
    engine: engine as unknown as DronePluginEngine,
    config,
    logger: silentLogger(),
    sessionManager,
    budgetService,
    onRetryPrompt: options.onRetryPrompt,
  });
  (engine as { getCapability: (id: string) => unknown }).getCapability = (
    id: string
  ) => (id === 'llm' ? llm : undefined);

  const events: Harness['events'] = [];
  const send = (prompt: string) =>
    conversation.sendUserMessage(prompt, event =>
      events.push(event as Harness['events'][number])
    );
  return { conversation, provider, events, send };
}

// Fast retry config for tests (no real 1s waits).
const FAST_RETRY = {
  maxRetries: 3,
  maxWaitMs: 5,
  backoffBaseMs: 1,
  backoffFactor: 1,
};

describe('conversation-service retry policy', () => {
  it('silently auto-retries transient 429 then succeeds (T1)', async () => {
    const { send, provider, events } = await setup({
      chatImpl: async attempt => {
        if (attempt < 3) {
          throw new DroneLlmError('rate limited', {
            status: 429,
            retryable: true,
            retryAfterMs: 1,
          });
        }
        return { message: 'finally ok' };
      },
      retry: { ...FAST_RETRY },
    });

    const result = await send('hi');
    expect(result).toBe('finally ok');
    expect(provider.__chatMock).toHaveBeenCalledTimes(3);
    const notices = events.filter(e => e.kind === 'notice');
    expect(notices.length).toBe(2);
    expect(notices[0].content).toContain('retrying');
  });

  it('retries 5xx then prompts the user once exhausted (T1→T2)', async () => {
    const onRetryPrompt = vi.fn(async () => false);
    const h = await setup({
      chatImpl: () => {
        throw new DroneLlmError('server overloaded', {
          status: 503,
          retryable: true,
        });
      },
      onRetryPrompt,
      retry: { ...FAST_RETRY, maxRetries: 2 },
    });

    await expect(h.send('hi')).rejects.toThrow('server overloaded');
    // Initial call + 2 auto-retries before prompting (maxRetries: 2).
    expect(h.provider.__chatMock).toHaveBeenCalledTimes(3);
    expect(onRetryPrompt).toHaveBeenCalledTimes(1);
  });

  it('prompts the user on a 401 without auto-retry (T2)', async () => {
    const onRetryPrompt = vi.fn(async () => false);
    const h = await setup({
      chatImpl: () => {
        throw new DroneLlmError('unauthorized', {
          status: 401,
          retryable: false,
        });
      },
      onRetryPrompt,
      retry: { ...FAST_RETRY },
    });

    await expect(h.send('hi')).rejects.toThrow('unauthorized');
    expect(h.provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(onRetryPrompt).toHaveBeenCalledTimes(1);
    // An error event should have been emitted before the prompt.
    expect(h.events.some(e => e.kind === 'error')).toBe(true);
  });

  it('retries when onRetryPrompt returns true (T2 continue)', async () => {
    const onRetryPrompt = vi.fn(async () => true);
    const h = await setup({
      chatImpl: async attempt => {
        if (attempt < 2) {
          throw new DroneLlmError('unauthorized', {
            status: 401,
            retryable: false,
          });
        }
        return { message: 'ok after retry' };
      },
      onRetryPrompt,
      retry: { ...FAST_RETRY },
    });

    const result = await h.send('hi');
    expect(result).toBe('ok after retry');
    expect(onRetryPrompt).toHaveBeenCalledTimes(1);
  });

  it('fails fast on transport (non-DroneLlmError) errors (T3)', async () => {
    const h = await setup({
      chatImpl: () => {
        throw new Error('ECONNREFUSED');
      },
    });

    await expect(h.send('hi')).rejects.toThrow('ECONNREFUSED');
    expect(h.provider.__chatMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast on context-window-exceeded with a /compact hint', async () => {
    const h = await setup({
      chatImpl: () => {
        throw new DroneLlmError('maximum context length exceeded', {
          status: 400,
          retryable: false,
        });
      },
    });

    await expect(h.send('hi')).rejects.toThrow(/compact/);
    expect(h.provider.__chatMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when promptOnError is false (no prompt)', async () => {
    const onRetryPrompt = vi.fn(async () => true);
    const h = await setup({
      chatImpl: () => {
        throw new DroneLlmError('unauthorized', {
          status: 401,
          retryable: false,
        });
      },
      onRetryPrompt,
      retry: { ...FAST_RETRY, promptOnError: false },
    });

    await expect(h.send('hi')).rejects.toThrow('unauthorized');
    expect(onRetryPrompt).not.toHaveBeenCalled();
    expect(h.provider.__chatMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when no onRetryPrompt callback is wired (non-interactive)', async () => {
    const h = await setup({
      chatImpl: () => {
        throw new DroneLlmError('unauthorized', {
          status: 401,
          retryable: false,
        });
      },
    });

    await expect(h.send('hi')).rejects.toThrow('unauthorized');
    expect(h.provider.__chatMock).toHaveBeenCalledTimes(1);
  });
});

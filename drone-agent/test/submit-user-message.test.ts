import { describe, expect, it, vi } from 'vitest';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import {
  createDefaultAgentConfig,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
} from 'drone-core';
import { createConversationService } from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { createMockEngine, silentLogger } from './helpers.js';

function makeProvider(
  chatResponses: DroneChatResponse[]
): DroneLlmProvider & { __chatMock: ReturnType<typeof vi.fn> } {
  const chatMock = vi.fn(async () => {
    if (chatResponses.length === 0) {
      return { message: 'no more responses queued' };
    }
    return chatResponses.shift() as DroneChatResponse;
  });
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
    getUsageLedger: () => [],
  };
}

function makeConversation(provider: DroneLlmProvider) {
  const engine = createMockEngine({
    tools: [],
    executeToolImpl: async () => JSON.stringify({}),
  });
  const config = createDefaultAgentConfig();
  const budgetService = createContextBudgetService({
    config,
    renderPromptFragments: async () => [],
    getProvider: () => provider,
    getModel: () => 'fake',
  });
  const conversation = createConversationService({
    engine: engine as unknown as DronePluginEngine,
    config,
    logger: silentLogger(),
    sessionManager: createSessionManager(),
    budgetService,
  });
  (engine as { getCapability: (id: string) => unknown }).getCapability = (
    id: string
  ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);
  return conversation;
}

describe('submitUserMessage — concurrency-safe synthetic turns', () => {
  it('sends immediately when no turn is in flight and returns the reply', async () => {
    const provider = makeProvider([{ message: 'immediate reply' }]);
    const conversation = makeConversation(provider);

    const reply = await conversation.submitUserMessage('hello');
    expect(reply).toBe('immediate reply');
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('queues when a turn is in flight, returning an empty string', async () => {
    const provider = makeProvider([
      { message: 'first reply' },
      { message: 'second reply' },
    ]);
    const conversation = makeConversation(provider);

    // Start a turn and hold it in flight by intercepting the chat call.
    let releaseFirst: (() => void) | undefined;
    provider.__chatMock.mockImplementationOnce(
      () =>
        new Promise<DroneChatResponse>(resolve => {
          releaseFirst = () => resolve({ message: 'first reply' });
        })
    );

    const firstTurn = conversation.sendUserMessage('first');
    // Allow sendUserMessage to set the in-flight flag.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(conversation.isTurnInFlight()).toBe(true);

    // Submit while in flight → should queue, not interleave.
    const queued = conversation.submitUserMessage('second');
    const queuedResult = await queued;
    expect(queuedResult).toBe('');

    releaseFirst?.();
    const firstReply = await firstTurn;
    expect(firstReply).toBe('first reply');

    // The queued message ('second') is drained and appended as a user turn at
    // the start of the next sendUserMessage call, which processes 'third'.
    const secondReply = await conversation.submitUserMessage('third');
    expect(conversation.getMessages().some(m => m.content === 'second')).toBe(
      true
    );
    expect(conversation.getMessages().some(m => m.content === 'third')).toBe(
      true
    );
    // The held first chat call resolved via its own promise (not the queue),
    // so the queue still holds ['first reply', 'second reply'] and the next
    // chat call shifts 'first reply'.
    // The held first chat call resolved via its own promise (not the queue),
    // so the queue still holds ['first reply', 'second reply'] and the next
    // chat call shifts 'first reply'.
    expect(secondReply).toBe('first reply');
  });

  it('serializes concurrent submissions so decisions do not interleave', async () => {
    const provider = makeProvider([
      { message: 'reply-1' },
      { message: 'reply-2' },
    ]);
    const conversation = makeConversation(provider);

    const [a, b] = await Promise.all([
      conversation.submitUserMessage('msg-a'),
      conversation.submitUserMessage('msg-b'),
    ]);

    // Both sent sequentially (never concurrently): each got a real reply.
    expect(a).toBe('reply-1');
    expect(b).toBe('reply-2');
    expect(provider.__chatMock).toHaveBeenCalledTimes(2);
  });

  it('a failing submission does not block subsequent submissions', async () => {
    const provider = makeProvider([{ message: 'ok reply' }]);
    const conversation = makeConversation(provider);

    // Force the first submission's provider call to fail.
    provider.__chatMock.mockRejectedValueOnce(new Error('llm exploded'));
    await expect(conversation.submitUserMessage('bad')).rejects.toThrow(
      /llm exploded/
    );

    const reply = await conversation.submitUserMessage('good');
    expect(reply).toBe('ok reply');
  });
});

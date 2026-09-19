/**
 * Behaviour tests for /steer mid-round injection and /btw ephemeral side-queries.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import {
  createDefaultAgentConfig,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneConversationEvent,
  type DroneLlmCapability,
  type DroneLlmProvider,
} from 'drone-core';
import {
  CANCEL_SENTINEL,
  createConversationService,
} from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { createMockEngine, silentLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makeConversation(
  provider: DroneLlmProvider,
  configure?: (config: ReturnType<typeof createDefaultAgentConfig>) => void,
  serviceOptions?: {
    onIdenticalToolCallLimitReached?: (
      toolName: string,
      args: Record<string, unknown>,
      count: number
    ) => Promise<boolean>;
    onToolIterationLimitReached?: (
      currentCount: number,
      maxCount: number
    ) => Promise<boolean>;
  }
) {
  const engine = createMockEngine({
    tools: [],
    executeToolImpl: async () => 'ok',
  });
  const config = createDefaultAgentConfig();
  configure?.(config);
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
    ...serviceOptions,
  });
  (engine as { getCapability: (id: string) => unknown }).getCapability = (
    id: string
  ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

  const events: DroneConversationEvent[] = [];
  engine.runConversationEventHooks = async event => {
    events.push(event);
  };
  return { conversation, engine, events };
}

/** Hold the first chat() call open so we can deterministically reach "busy". */
function holdFirstChat(
  provider: ReturnType<typeof makeProvider>,
  resolveValue: DroneChatResponse
): { release: () => void } {
  let release: (() => void) | undefined;
  provider.__chatMock.mockImplementationOnce(
    () =>
      new Promise<DroneChatResponse>(resolve => {
        release = () => resolve(resolveValue);
      })
  );
  return { release: () => release?.() };
}

const tick = () => new Promise(r => setTimeout(r, 10));

const toolCallResponse = (name = 't'): DroneChatResponse => ({
  toolCalls: [{ id: 'c1', name, arguments: {} }],
});

// ---------------------------------------------------------------------------
// /steer
// ---------------------------------------------------------------------------

describe('steerMessage', () => {
  it('absorbs a busy steer at the next loop boundary, before the next LLM call', async () => {
    const provider = makeProvider([{ message: 'final' }]);
    const { conversation, events } = makeConversation(provider);

    // First LLM call returns a tool call so the loop iterates once more.
    const held = holdFirstChat(provider, toolCallResponse());
    const turn = conversation.sendUserMessage('first');
    await tick();
    expect(conversation.isTurnInFlight()).toBe(true);

    // Busy → queued, not appended yet.
    await conversation.steerMessage('steered');
    expect(conversation.getMessages().some(m => m.content === 'steered')).toBe(
      false
    );

    held.release();
    const result = await turn;
    expect(result).toBe('final');

    // The SECOND chat call must already contain the steered user turn.
    const secondRequest = provider.__chatMock.mock.calls[1][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(
      secondRequest.messages.some(
        m => m.role === 'user' && m.content === 'steered'
      )
    ).toBe(true);

    // Busy branch emits a steering notice; the boundary emits a userMessage.
    expect(
      events.some(
        e => e.kind === 'notice' && e.content === '[steering: steered]'
      )
    ).toBe(true);
    expect(
      events.some(e => e.kind === 'userMessage' && e.content === 'steered')
    ).toBe(true);
  });

  it('runs a full round with lifecycle hooks when idle', async () => {
    const provider = makeProvider([{ message: 'idle-final' }]);
    const { conversation, engine } = makeConversation(provider);
    const hooks: string[] = [];
    engine.runHooks = async (name: string) => {
      hooks.push(name);
    };

    await conversation.steerMessage('hello when idle');

    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(hooks).toContain('onBeforePrompt');
    expect(hooks).toContain('onAfterToolCall');
  });

  it('discards a late steer on normal completion, with a notice', async () => {
    const provider = makeProvider([]);
    const { conversation, events } = makeConversation(provider);

    // Round completes on the first response (no tool calls), so the queued
    // steer never reaches a boundary.
    const held = holdFirstChat(provider, { message: 'done' });
    const turn = conversation.sendUserMessage('first');
    await tick();
    await conversation.steerMessage('too late');
    held.release();
    await turn;

    expect(
      events.some(
        e =>
          e.kind === 'notice' &&
          e.content ===
            '[steering: discarded late steering message: "too late"]'
      )
    ).toBe(true);
    expect(conversation.getMessages().some(m => m.content === 'too late')).toBe(
      false
    );
  });

  it('discards a late steer on cancellation, with a notice', async () => {
    const provider = makeProvider([{ message: 'never' }]);
    const { conversation, events } = makeConversation(provider);

    // Tool call forces a second iteration, where the cancel check runs.
    const held = holdFirstChat(provider, toolCallResponse());
    const turn = conversation.sendUserMessage('first');
    await tick();
    await conversation.steerMessage('late on cancel');
    conversation.cancelCurrentRequest();
    held.release();

    const result = await turn;
    expect(result).toBe(CANCEL_SENTINEL);
    expect(
      events.some(
        e =>
          e.kind === 'notice' &&
          e.content ===
            '[steering: discarded late steering message: "late on cancel"]'
      )
    ).toBe(true);
  });

  it('clearSession flushes queued steering messages', async () => {
    const provider = makeProvider([{ message: 'never' }]);
    const { conversation, events } = makeConversation(provider);

    const held = holdFirstChat(provider, toolCallResponse());
    const turn = conversation.sendUserMessage('first');
    await tick();
    await conversation.steerMessage('cleared-away');
    conversation.clearSession();
    held.release();
    await turn;

    expect(
      events.some(
        e =>
          e.kind === 'notice' && e.content.includes('discarded late steering')
      )
    ).toBe(false);
    expect(
      conversation.getMessages().some(m => m.content === 'cleared-away')
    ).toBe(false);
  });

  it('absorbing a steer resets the identical-tool-call streak (escapes a loop)', async () => {
    // With this guardrail the identical-call hard limit trips at streak 3.
    // The tool enqueues a steer on every execution; the steer resets the
    // streak at each loop top, so the streak never exceeds 1 and the turn
    // escapes to the final message instead of aborting.
    const provider = makeProvider([
      toolCallResponse('t'),
      toolCallResponse('t'),
      toolCallResponse('t'),
      toolCallResponse('t'),
      toolCallResponse('t'),
      { message: 'escaped' },
    ]);
    const { conversation, engine } = makeConversation(provider, cfg => {
      cfg.session.guardrail.identicalToolCalls = { hintAfter: 0, maxHints: 2 };
      cfg.session.maxToolIterations = 100;
    });
    const exec = (engine as { __executeMock: ReturnType<typeof vi.fn> })
      .__executeMock;
    exec.mockImplementation(async () => {
      await conversation.steerMessage('keep going');
      return 'ok';
    });

    const result = await conversation.sendUserMessage('first');
    expect(result).toBe('escaped');
  });

  it('a steer does not extend the tool-call iteration limit', async () => {
    // Same steering pressure, but the depth limit must still fire: a steer
    // resets the degeneracy guards, never `iterationCount`.
    const provider = makeProvider([
      toolCallResponse('t'),
      toolCallResponse('t'),
      toolCallResponse('t'),
      toolCallResponse('t'),
    ]);
    const onIterationLimit = vi.fn(async () => false);
    const { conversation, engine } = makeConversation(
      provider,
      cfg => {
        cfg.session.maxToolIterations = 1;
      },
      { onToolIterationLimitReached: onIterationLimit }
    );
    const exec = (engine as { __executeMock: ReturnType<typeof vi.fn> })
      .__executeMock;
    exec.mockImplementation(async () => {
      await conversation.steerMessage('keep going');
      return 'ok';
    });

    await expect(conversation.sendUserMessage('first')).rejects.toThrow(
      /depth exceeded/
    );
    expect(onIterationLimit).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /btw
// ---------------------------------------------------------------------------

describe('askAside', () => {
  it('sends one tool-less request over the assembled context and emits an aside', async () => {
    const provider = makeProvider([{ message: 'the answer' }]);
    const { conversation, events } = makeConversation(provider);

    const answer = await conversation.askAside('what is the plan?');
    expect(answer).toBe('the answer');
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);

    const request = provider.__chatMock.mock.calls[0][0] as {
      tools?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.tools).toBeUndefined();
    // Starts with the header system run.
    expect(request.messages[0].role).toBe('system');
    // Ends with the framed question.
    const last = request.messages[request.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('SIDE QUESTION');
    expect(last.content).toContain('what is the plan?');

    const aside = events.find(e => e.kind === 'aside');
    expect(aside).toEqual({
      kind: 'aside',
      question: 'what is the plan?',
      answer: 'the answer',
    });
  });

  it('leaves session history untouched', async () => {
    const provider = makeProvider([{ message: 'ans' }]);
    const { conversation } = makeConversation(provider);
    const before = conversation.getMessages().length;
    await conversation.askAside('side question');
    expect(conversation.getMessages().length).toBe(before);
  });

  it('runs concurrently with an in-flight turn without disturbing it', async () => {
    const provider = makeProvider([{ message: 'side answer' }]);
    const { conversation } = makeConversation(provider);

    const held = holdFirstChat(provider, { message: 'first final' });
    const turn = conversation.sendUserMessage('first');
    await tick();
    expect(conversation.isTurnInFlight()).toBe(true);

    const answer = await conversation.askAside('side?');
    expect(answer).toBe('side answer');
    expect(conversation.isTurnInFlight()).toBe(true);

    held.release();
    expect(await turn).toBe('first final');
  });
});

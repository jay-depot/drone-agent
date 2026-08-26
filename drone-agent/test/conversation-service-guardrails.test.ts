import { describe, expect, it, vi } from 'vitest';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import {
  createDefaultAgentConfig,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DroneGuardrailConfig,
} from 'drone-core';
import { createConversationService } from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import type { ContextBudgetService } from '../src/runtime/context-budget-service.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { createMockEngine, silentLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Test fixtures
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
    setReasoningLevel: (_level: any) => {},
    listModels: async () => ['fake'],
    registerDriver: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
  };
}

function makeBudgetService(
  provider: DroneLlmProvider,
  promptFragments?: string[]
): ContextBudgetService {
  return createContextBudgetService({
    config: createDefaultAgentConfig(),
    renderPromptFragments: async () => promptFragments ?? [],
    getProvider: () => provider,
    getModel: () => 'fake',
  });
}

const defaultGuardrail: DroneGuardrailConfig = {
  brokenResponses: { hintAfter: 2, maxHints: 2 },
  reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
  identicalToolCalls: { hintAfter: 2, maxHints: 3 },
};

// ---------------------------------------------------------------------------
// Feature 1: Broken response detection & retry
// ---------------------------------------------------------------------------

describe('createConversationService — broken response guardrails', () => {
  it('retries truly-empty responses up to hintAfter before injecting hints', async () => {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => '',
    });
    const provider = makeProvider([
      // First two: empty responses (phase 1, no hint)
      { message: '' },
      { message: '' },
      // Next two: empty with hint (phase 2)
      { message: '' },
      { message: 'hinted response' },
    ]);
    const llm = makeLlmCapability(provider);
    const config = createDefaultAgentConfig();
    config.session.guardrail = {
      ...defaultGuardrail,
      brokenResponses: { hintAfter: 2, maxHints: 2 },
    };
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? llm : undefined);

    const events: any[] = [];
    const result = await conversation.sendUserMessage('test', event => {
      events.push(event);
    });

    // The final response should be the hinted response
    expect(result).toBe('hinted response');

    // Notice events should have been emitted for broken responses
    const noticeEvents = events.filter(e => e.kind === 'notice');
    // First 2: no-hint retries (phase 1)
    // 3rd: hint retry (phase 2)
    expect(noticeEvents.length).toBeGreaterThanOrEqual(3);
    expect(noticeEvents[0].content).toContain('Degenerate response (empty)');
    expect(noticeEvents[0].content).toContain('retrying');
  });

  it('emits a notice for reasoning-only responses', async () => {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => '',
    });
    const provider = makeProvider([
      // Reasoning-only response (has reasoning but no message, no tool calls)
      { message: '', reasoning: 'Let me think about this...' },
      // Then a good response
      { message: 'Here is my answer' },
    ]);
    const llm = makeLlmCapability(provider);
    const config = createDefaultAgentConfig();
    config.session.guardrail = {
      ...defaultGuardrail,
      reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
    };
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? llm : undefined);

    const events: any[] = [];
    const result = await conversation.sendUserMessage('test', event => {
      events.push(event);
    });

    expect(result).toBe('Here is my answer');
    const noticeEvents = events.filter(e => e.kind === 'notice');
    expect(noticeEvents.length).toBe(1);
    expect(noticeEvents[0].content).toContain('reasoning-only');
  });

  it('returns empty string when broken-response limit is reached without callback', async () => {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => '',
    });
    // 2 phase 1 + 2 phase 2 + limit = 4 total empty responses, then hard limit
    const provider = makeProvider([
      { message: '' },
      { message: '' },
      { message: '' },
      { message: '' },
    ]);
    const llm = makeLlmCapability(provider);
    const config = createDefaultAgentConfig();
    config.session.guardrail = {
      ...defaultGuardrail,
      brokenResponses: { hintAfter: 2, maxHints: 2 },
    };
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      // No onBrokenResponseLimitReached callback
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? llm : undefined);

    const result = await conversation.sendUserMessage('test');
    expect(result).toBe('');
  });

  it('calls onBrokenResponseLimitReached when hard limit is reached', async () => {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => '',
    });
    const provider = makeProvider([
      { message: '' },
      { message: '' },
      { message: '' },
      { message: '' },
    ]);
    const llm = makeLlmCapability(provider);
    const config = createDefaultAgentConfig();
    config.session.guardrail = {
      ...defaultGuardrail,
      brokenResponses: { hintAfter: 2, maxHints: 2 },
    };
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);

    const limitReached = vi.fn(async () => false);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      onBrokenResponseLimitReached: limitReached,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? llm : undefined);

    const result = await conversation.sendUserMessage('test');
    expect(result).toBe('');
    expect(limitReached).toHaveBeenCalledWith('empty');
  });
});

// ---------------------------------------------------------------------------
// Feature 2: Identical tool-call streak detection
// ---------------------------------------------------------------------------

describe('createConversationService — identical tool-call streak detection', () => {
  it('resets streak when tool calls differ', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'file__read',
          description: 'read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
      executeToolImpl: async () => 'content',
    });
    // Call file__read with different paths — streak should not grow
    const provider = makeProvider([
      {
        toolCalls: [
          { id: 'call-1', name: 'file__read', arguments: { path: '/a' } },
        ],
      },
      {
        toolCalls: [
          { id: 'call-2', name: 'file__read', arguments: { path: '/b' } },
        ],
      },
      { message: 'Done' },
    ]);
    const llm = makeLlmCapability(provider);
    const config = createDefaultAgentConfig();
    config.session.guardrail = {
      ...defaultGuardrail,
      identicalToolCalls: { hintAfter: 2, maxHints: 3 },
    };
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? llm : undefined);

    const events: any[] = [];
    const result = await conversation.sendUserMessage('test', event => {
      events.push(event);
    });

    expect(result).toBe('Done');
    // No notice events — streak was reset each time due to different args
    const noticeEvents = events.filter(e => e.kind === 'notice');
    expect(noticeEvents).toHaveLength(0);
  });

  it('emits notice and nudge when identical tool call is repeated beyond hintAfter', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'file__read',
          description: 'read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
      executeToolImpl: async () => 'content',
    });
    // Same tool call repeated 4 times (hintAfter=2, so 3rd triggers nudge)
    const provider = makeProvider([
      {
        toolCalls: [
          { id: 'call-1', name: 'file__read', arguments: { path: '/a' } },
        ],
      },
      {
        toolCalls: [
          { id: 'call-2', name: 'file__read', arguments: { path: '/a' } },
        ],
      },
      {
        toolCalls: [
          { id: 'call-3', name: 'file__read', arguments: { path: '/a' } },
        ],
      },
      { message: 'Final answer' },
    ]);
    const llm = makeLlmCapability(provider);
    const config = createDefaultAgentConfig();
    config.session.guardrail = {
      ...defaultGuardrail,
      identicalToolCalls: { hintAfter: 2, maxHints: 3 },
    };
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? llm : undefined);

    const events: any[] = [];
    const result = await conversation.sendUserMessage('test', event => {
      events.push(event);
    });

    expect(result).toBe('Final answer');
    const noticeEvents = events.filter(e => e.kind === 'notice');
    expect(noticeEvents.length).toBeGreaterThanOrEqual(1);
    expect(noticeEvents[0].content).toContain('repeated identical tool call');
  });

  it('resets stuck detectors via resetStuckDetectors()', async () => {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => '',
    });
    const provider = makeProvider([{ message: 'hello' }]);
    const llm = makeLlmCapability(provider);
    const config = createDefaultAgentConfig();
    config.session.guardrail = defaultGuardrail;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? llm : undefined);

    // resetStuckDetectors should not throw
    expect(() => conversation.resetStuckDetectors()).not.toThrow();
  });

  it('throws error when identical tool call limit is reached without callback', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'file__read',
          description: 'read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
      executeToolImpl: async () => 'content',
    });
    // hintAfter=2, maxHints=0 → limit reached at streak=3 (2+0+1)
    const responses: DroneChatResponse[] = [];
    for (let i = 0; i < 10; i++) {
      responses.push({
        toolCalls: [
          { id: `call-${i}`, name: 'file__read', arguments: { path: '/a' } },
        ],
      });
    }
    const provider = makeProvider(responses);
    const llm = makeLlmCapability(provider);
    const config = createDefaultAgentConfig();
    config.session.guardrail = {
      ...defaultGuardrail,
      identicalToolCalls: { hintAfter: 2, maxHints: 0 },
    };
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      // No onIdenticalToolCallLimitReached callback
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? llm : undefined);

    await expect(conversation.sendUserMessage('test')).rejects.toThrow(
      'appears stuck'
    );
  });
});

// ---------------------------------------------------------------------------
// Feature 3: Assistant text before tool calls
// ---------------------------------------------------------------------------

describe('createConversationService — assistant text emitted before toolCallBatch', () => {
  it('emits assistantMessage event before toolCallBatch when response has text and tool calls', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'file__read',
          description: 'read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
      executeToolImpl: async () => 'content',
    });
    const provider = makeProvider([
      {
        message: 'Let me read that file for you.',
        toolCalls: [
          { id: 'call-1', name: 'file__read', arguments: { path: '/a' } },
        ],
      },
      { message: 'Here is the result.' },
    ]);
    const llm = makeLlmCapability(provider);
    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? llm : undefined);

    const events: any[] = [];
    await conversation.sendUserMessage('test', event => {
      events.push(event);
    });

    // Find the indices of assistantMessage and toolCallBatch
    const assistantMsgIdx = events.findIndex(
      e => e.kind === 'assistantMessage'
    );
    const toolCallBatchIdx = events.findIndex(e => e.kind === 'toolCallBatch');

    expect(assistantMsgIdx).toBeGreaterThanOrEqual(0);
    expect(toolCallBatchIdx).toBeGreaterThanOrEqual(0);
    expect(assistantMsgIdx).toBeLessThan(toolCallBatchIdx);
  });
});

// ---------------------------------------------------------------------------
// Config schema validation
// ---------------------------------------------------------------------------

describe('guardrail config defaults', () => {
  it('includes default guardrail config in createDefaultAgentConfig', () => {
    const config = createDefaultAgentConfig();
    const guardrail = config.session.guardrail;
    expect(guardrail).toBeDefined();
    expect(guardrail?.brokenResponses?.hintAfter).toBe(2);
    expect(guardrail?.brokenResponses?.maxHints).toBe(2);
    expect(guardrail?.reasoningOnlyResponses?.hintAfter).toBe(4);
    expect(guardrail?.reasoningOnlyResponses?.maxHints).toBe(2);
    expect(guardrail?.identicalToolCalls?.hintAfter).toBe(2);
    expect(guardrail?.identicalToolCalls?.maxHints).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Notice event emission
// ---------------------------------------------------------------------------

describe('createConversationService — notice event emission', () => {
  it('emits notice events with kind "notice" and content string', async () => {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => '',
    });
    const provider = makeProvider([{ message: '' }, { message: 'got it' }]);
    const llm = makeLlmCapability(provider);
    const config = createDefaultAgentConfig();
    config.session.guardrail = {
      ...defaultGuardrail,
      brokenResponses: { hintAfter: 2, maxHints: 2 },
    };
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? llm : undefined);

    const events: any[] = [];
    await conversation.sendUserMessage('test', event => {
      events.push(event);
    });

    const noticeEvents = events.filter(e => e.kind === 'notice');
    expect(noticeEvents.length).toBeGreaterThanOrEqual(1);
    expect(typeof noticeEvents[0].content).toBe('string');
    expect(noticeEvents[0].content.length).toBeGreaterThan(0);
  });
});

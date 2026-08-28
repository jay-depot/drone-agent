import { describe, expect, it } from 'vitest';
import {
  estimateMessageTokens,
  estimateSessionBudget,
  estimateTextTokens,
  estimateToolDescriptorTokens,
  estimateTurnTokens,
  type DroneChatMessage,
  type DroneSessionTurn,
  type DroneToolDescriptor,
} from '../src/index.js';
import { estimateTextTokens as estimateTextTokensModule } from '../src/token-estimate.js';

describe('estimateTextTokens', () => {
  it('returns at least 1 for empty strings', () => {
    expect(estimateTextTokens('')).toBe(1);
  });

  it('rounds up length / 4', () => {
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
    expect(estimateTextTokens('a'.repeat(16))).toBe(4);
  });

  it('is exported from the package barrel', () => {
    expect(estimateTextTokensModule).toBe(estimateTextTokens);
  });
});

describe('estimateMessageTokens', () => {
  it('includes the base overhead of 6 plus content tokens', () => {
    const tokens = estimateMessageTokens({
      role: 'user',
      content: 'hello',
    });
    // 6 base + ceil(5/4) = 2 -> 8
    expect(tokens).toBe(8);
  });

  it('adds tool name tokens when present', () => {
    const baseTokens = estimateMessageTokens({
      role: 'tool',
      content: 'ok',
    });
    const withToolName = estimateMessageTokens({
      role: 'tool',
      content: 'ok',
      toolName: 'search',
    });
    // "search" = ceil(6/4) = 2 extra tokens
    expect(withToolName - baseTokens).toBe(2);
  });

  it('adds toolCallId tokens when present', () => {
    const baseTokens = estimateMessageTokens({
      role: 'tool',
      content: 'ok',
    });
    const withToolCallId = estimateMessageTokens({
      role: 'tool',
      content: 'ok',
      toolCallId: 'call-12345678',
    });
    // toolCallId length is 13 -> ceil(13/4) = 4 extra
    expect(withToolCallId - baseTokens).toBe(4);
  });

  it('accounts for tool call payloads when present', () => {
    const message: DroneChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'read',
          arguments: { path: '/tmp/foo' },
        },
      ],
    };
    const tokens = estimateMessageTokens(message);
    const emptyTokens = estimateMessageTokens({
      role: 'assistant',
      content: '',
    });
    expect(tokens).toBeGreaterThan(emptyTokens);
  });

  it('ignores empty tool-call arrays', () => {
    const withEmpty: DroneChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [],
    };
    const without: DroneChatMessage = {
      role: 'assistant',
      content: '',
    };
    expect(estimateMessageTokens(withEmpty)).toBe(
      estimateMessageTokens(without)
    );
  });

  it('adds ~256 tokens per image when images are present', () => {
    const base: DroneChatMessage = { role: 'user', content: 'hello' };
    const baseTokens = estimateMessageTokens(base);

    const withOneImage: DroneChatMessage = {
      role: 'user',
      content: 'hello',
      images: [{ mimeType: 'image/jpeg', data: 'abc123' }],
    };
    expect(estimateMessageTokens(withOneImage)).toBe(baseTokens + 256);
  });

  it('adds 256 tokens per image for multiple images', () => {
    const base: DroneChatMessage = { role: 'user', content: 'hello' };
    const baseTokens = estimateMessageTokens(base);

    const withTwoImages: DroneChatMessage = {
      role: 'user',
      content: 'hello',
      images: [
        { mimeType: 'image/png', data: 'abc' },
        { mimeType: 'image/jpeg', data: 'def' },
      ],
    };
    expect(estimateMessageTokens(withTwoImages)).toBe(baseTokens + 512);
  });
});

describe('estimateToolDescriptorTokens', () => {
  it('sums base, name, description and schema tokens', () => {
    const tool: DroneToolDescriptor = {
      name: 'read',
      description: 'Reads a file from disk.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
      },
    };
    const tokens = estimateToolDescriptorTokens(tool);
    // 8 base + ceil(4/4) + ceil(22/4) + schema JSON
    expect(tokens).toBeGreaterThan(8);
  });

  it('handles a missing input schema', () => {
    const tool: DroneToolDescriptor = {
      name: 'noop',
      description: '',
    };
    const tokens = estimateToolDescriptorTokens(tool);
    // 8 base + ceil(4/4)=1 + ceil(0/4)=1 + JSON.stringify({})="{}" ceil(2/4)=1 -> 11
    expect(tokens).toBe(11);
  });
});

describe('estimateTurnTokens', () => {
  it('sums all message tokens in a turn', () => {
    const turn: DroneSessionTurn = {
      id: 't1',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello there' },
      ],
    };
    const expected =
      estimateMessageTokens(turn.messages[0]) +
      estimateMessageTokens(turn.messages[1]);
    expect(estimateTurnTokens(turn)).toBe(expected);
  });
});

describe('estimateSessionBudget', () => {
  const sessionConfig = {
    contextWindowTokens: 1000,
    responseReserveTokens: 200,
    maxToolIterations: 50,
    guardrail: {
      brokenResponses: { hintAfter: 2, maxHints: 2 },
      reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
      identicalToolCalls: { hintAfter: 2, maxHints: 3 },
    },
    retry: {
      maxRetries: 3,
      maxWaitMs: 30000,
      promptOnError: true,
      backoffBaseMs: 1000,
      backoffFactor: 2,
    },
  };

  it('aggregates system, session, and tool token estimates', () => {
    const turn: DroneSessionTurn = {
      id: 't1',
      messages: [{ role: 'user', content: 'ping' }],
    };
    const tool: DroneToolDescriptor = {
      name: 'noop',
      description: 'noop',
    };
    const budget = estimateSessionBudget({
      systemMessages: [{ role: 'system', content: 'sys' }],
      turns: [turn],
      tools: [tool],
      sessionConfig,
      contextWindowTokens: sessionConfig.contextWindowTokens,
    });
    expect(budget.estimatedSystemTokens).toBeGreaterThan(0);
    expect(budget.estimatedSessionTokens).toBeGreaterThan(0);
    expect(budget.estimatedToolTokens).toBeGreaterThan(0);
    expect(budget.estimatedPromptTokens).toBe(
      budget.estimatedSystemTokens +
        budget.estimatedSessionTokens +
        budget.estimatedToolTokens
    );
    expect(budget.reservedResponseTokens).toBe(
      sessionConfig.responseReserveTokens
    );
    expect(budget.estimatedTotalTokens).toBe(
      budget.estimatedPromptTokens + budget.reservedResponseTokens
    );
    expect(budget.contextWindowTokens).toBe(sessionConfig.contextWindowTokens);
    expect(budget.maxPromptTokens).toBe(
      sessionConfig.contextWindowTokens - sessionConfig.responseReserveTokens
    );
  });

  it('flags requiresSafetyTrim when prompt tokens exceed maxPromptTokens', () => {
    // Build a session that overshoots the window with one big system message.
    const giantContent = 'x'.repeat(10_000);
    const budget = estimateSessionBudget({
      systemMessages: [{ role: 'system', content: giantContent }],
      turns: [],
      tools: [],
      sessionConfig,
      contextWindowTokens: sessionConfig.contextWindowTokens,
    });
    expect(budget.requiresSafetyTrim).toBe(true);
  });

  it('reports requiresSafetyTrim=false when the budget fits', () => {
    const budget = estimateSessionBudget({
      systemMessages: [{ role: 'system', content: 'short' }],
      turns: [],
      tools: [],
      sessionConfig,
      contextWindowTokens: sessionConfig.contextWindowTokens,
    });
    expect(budget.requiresSafetyTrim).toBe(false);
  });

  it('keeps maxPromptTokens at least 1 for tiny context windows', () => {
    const tinyBudget = estimateSessionBudget({
      systemMessages: [],
      turns: [],
      tools: [],
      sessionConfig: {
        contextWindowTokens: 1,
        responseReserveTokens: 0,
        maxToolIterations: 1,
        guardrail: {
          brokenResponses: { hintAfter: 2, maxHints: 2 },
          reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
          identicalToolCalls: { hintAfter: 2, maxHints: 3 },
        },
        retry: {
          maxRetries: 3,
          maxWaitMs: 30000,
          promptOnError: true,
          backoffBaseMs: 1000,
          backoffFactor: 2,
        },
      },
      contextWindowTokens: 1,
    });
    expect(tinyBudget.maxPromptTokens).toBeGreaterThanOrEqual(1);
  });
});

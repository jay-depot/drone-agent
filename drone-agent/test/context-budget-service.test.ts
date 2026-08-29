import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig,
  createRuntimeFlagRegistry,
  type DroneAgentConfig,
  type DroneChatMessage,
  type DroneContextWindowInfo,
  type DroneSessionTurn,
} from 'drone-core';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';

function makeBudgetService(
  flags?: () => ReturnType<typeof createRuntimeFlagRegistry>,
  config: DroneAgentConfig = createDefaultAgentConfig()
) {
  return createContextBudgetService({
    config,
    renderPromptFragments: async () => [],
    getProvider: () => ({
      chat: async () => ({ message: '' }),
      getContextWindowInfo: async () => ({
        model: 'fake',
        contextWindowTokens: 100_000,
        source: 'config' as const,
      }),
    }),
    getModel: () => 'fake',
    runtimeFlags: flags,
  });
}

function makeTurn(content: string, kind?: 'summary'): DroneSessionTurn {
  return {
    id: content,
    messages: [{ role: 'user', content }],
    kind,
  };
}

describe('context-budget-service runtime flags injection', () => {
  it('excludes flags block when no registry is provided', async () => {
    const svc = makeBudgetService();
    const msgs = await svc.buildSystemMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).not.toContain('Runtime Flags');
  });

  it('excludes flags block when registry is empty', async () => {
    const registry = createRuntimeFlagRegistry();
    const svc = makeBudgetService(() => registry);
    const msgs = await svc.buildSystemMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).not.toContain('Runtime Flags');
  });

  it('includes flags block when registry has plugins flag', async () => {
    const registry = createRuntimeFlagRegistry();
    registry.set('plugins', 'exec, file, git, lsp');
    const svc = makeBudgetService(() => registry);
    const msgs = await svc.buildSystemMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).not.toContain('Runtime Flags');
    expect(msgs[1].content).toContain('# Runtime Flags');
    expect(msgs[1].content).toContain('## Tool Management');
    expect(msgs[1].content).toContain('plugins: exec, file, git, lsp');
  });

  it('includes flags block for arbitrary flags', async () => {
    const registry = createRuntimeFlagRegistry();
    registry.set('debug', 'llm');
    const svc = makeBudgetService(() => registry);
    const msgs = await svc.buildSystemMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[1].content).toContain('# Runtime Flags');
    expect(msgs[1].content).toContain('debug: llm');
  });
});

describe('context-budget-service evaluateSafetyTrim', () => {
  // contextWindowTokens 500 - responseReserveTokens 100 => maxPromptTokens 400.
  const config = createDefaultAgentConfig({
    session: {
      contextWindowTokens: 500,
      responseReserveTokens: 100,
      maxToolIterations: 50,
      maxImageSizeBytes: 20 * 1024 * 1024,
      promptOnToolIterationLimit: false,
      maxToolResultTokensPercent: 15,
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
  });
  const contextWindow: DroneContextWindowInfo = {
    model: 'fake',
    contextWindowTokens: 500,
    source: 'config',
  };
  const systemMessages: DroneChatMessage[] = [{ role: 'system', content: 'x' }];

  it('reports no trim needed when the budget fits', () => {
    const svc = makeBudgetService(undefined, config);
    const evaluation = svc.evaluateSafetyTrim({
      systemMessages,
      contextWindow,
      turns: [makeTurn('hi')],
      tools: [],
    });
    expect(evaluation).toEqual({ requiresTrim: false });
  });

  it('skips a summary between non-summary turns when counting droppable turns', () => {
    const svc = makeBudgetService(undefined, config);
    const turns = [
      makeTurn('a'.repeat(800)),
      makeTurn('b'.repeat(800)),
      makeTurn('S', 'summary'),
      makeTurn('c'.repeat(800)),
    ];
    const evaluation = svc.evaluateSafetyTrim({
      systemMessages,
      contextWindow,
      turns,
      tools: [],
    });
    expect(evaluation).toEqual({
      requiresTrim: true,
      requiredDropTurnCount: 2,
    });
  });

  it('skips a head summary and counts the non-summary turns after it as droppable', () => {
    const svc = makeBudgetService(undefined, config);
    const turns = [
      makeTurn('S', 'summary'),
      makeTurn('a'.repeat(800)),
      makeTurn('b'.repeat(800)),
    ];
    const evaluation = svc.evaluateSafetyTrim({
      systemMessages,
      contextWindow,
      turns,
      tools: [],
    });
    expect(evaluation).toEqual({
      requiresTrim: true,
      requiredDropTurnCount: 1,
    });
  });

  it('returns null when dropping all non-summary turns still exceeds the budget', () => {
    const svc = makeBudgetService(undefined, config);
    const hugeSystem: DroneChatMessage[] = [
      { role: 'system', content: 'z'.repeat(2000) },
    ];
    const turns = [makeTurn('a'.repeat(800)), makeTurn('b'.repeat(800))];
    const evaluation = svc.evaluateSafetyTrim({
      systemMessages: hugeSystem,
      contextWindow,
      turns,
      tools: [],
    });
    expect(evaluation).toBeNull();
  });
});

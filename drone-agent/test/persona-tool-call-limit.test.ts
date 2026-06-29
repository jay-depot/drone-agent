import { describe, expect, it, vi } from 'vitest';
import { parsePersonaMd } from '../src/plugins/persona/loader.js';
import {
  createDefaultAgentConfig,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DroneToolDescriptor,
} from 'drone-core';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import { createConversationService } from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import type { ContextBudgetService } from '../src/runtime/context-budget-service.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { silentLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Step 5, test 1: Parsing toolCallLimit from persona frontmatter
// ---------------------------------------------------------------------------

describe('parsePersonaMd — toolCallLimit field', () => {
  it('parses a valid positive integer toolCallLimit from frontmatter', () => {
    const p = parsePersonaMd(
      'coder',
      [
        '---',
        'name: Coder',
        'description: Focused on implementation',
        'toolCallLimit: 100',
        '---',
        'You are a coding agent.',
      ].join('\n')
    );

    expect(p.toolCallLimit).toBe(100);
  });

  it('leaves toolCallLimit undefined when the persona omits the field', () => {
    const p = parsePersonaMd(
      'plain',
      ['---', 'name: Plain', 'description: A plain persona', '---'].join('\n')
    );

    expect(p.toolCallLimit).toBeUndefined();
  });

  it('leaves toolCallLimit undefined when there is no frontmatter', () => {
    const p = parsePersonaMd('bare', 'Just a system prompt override.');

    expect(p.toolCallLimit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Step 5, test 2: Invalid toolCallLimit values are silently ignored
// ---------------------------------------------------------------------------

describe('parsePersonaMd — invalid toolCallLimit values', () => {
  it('silently ignores a negative toolCallLimit', () => {
    const p = parsePersonaMd(
      'coder',
      ['---', 'toolCallLimit: -1', '---'].join('\n')
    );

    expect(p.toolCallLimit).toBeUndefined();
  });

  it('silently ignores a zero toolCallLimit', () => {
    const p = parsePersonaMd(
      'coder',
      ['---', 'toolCallLimit: 0', '---'].join('\n')
    );

    expect(p.toolCallLimit).toBeUndefined();
  });

  it('silently ignores a non-integer toolCallLimit', () => {
    const p = parsePersonaMd(
      'coder',
      ['---', 'toolCallLimit: 3.14', '---'].join('\n')
    );

    expect(p.toolCallLimit).toBeUndefined();
  });

  it('silently ignores a non-numeric toolCallLimit string', () => {
    const p = parsePersonaMd(
      'coder',
      ['---', 'toolCallLimit: unlimited', '---'].join('\n')
    );

    expect(p.toolCallLimit).toBeUndefined();
  });

  it('silently ignores a NaN toolCallLimit', () => {
    const p = parsePersonaMd(
      'coder',
      ['---', 'toolCallLimit: not-a-number', '---'].join('\n')
    );

    expect(p.toolCallLimit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helpers for conversation service tests
// ---------------------------------------------------------------------------

type EngineOptions = {
  tools: DroneToolDescriptor[];
  executeToolImpl: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<string>;
  promptFragments?: string[];
  /** Optional persona capability to return from getCapability('persona'). */
  personaCap?: {
    getActivePersona: () => { toolCallLimit?: number } | null;
    getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  };
};

function makeEngine(options: EngineOptions): DronePluginEngine & {
  __executeMock: ReturnType<typeof vi.fn>;
} {
  const executeMock = vi.fn(options.executeToolImpl);
  const toolList = options.tools;

  return {
    initialize: async () => [],
    runHooks: async () => {},
    runSessionSafetyTrimWillRunHooks: async () => {},
    runSessionSafetyTrimAppliedHooks: async () => {},
    renderPromptFragments: async () => options.promptFragments ?? [],
    getTool: () => undefined,
    executeTool: executeMock as unknown as DronePluginEngine['executeTool'],
    listTools: () => toolList,
    getCapability: <T>(id: string) => {
      if (id === 'llm') return {} as unknown as T;
      if (id === 'persona') return options.personaCap as unknown as T;
      return undefined;
    },
    listPlugins: () => [],
    getRegisteredPluginCount: () => 0,
    getRegisteredToolCount: () => toolList.length,
    getHelpSnippets: () => [],
    getConfig: () => {
      throw new Error('getConfig not used in conversation-service tests');
    },
    setElicitation: () => {},
    getElicitation: () => undefined,
    runWorkflow: async () => {
      throw new Error('runWorkflow not used in conversation-service tests');
    },
    dispatchSlashCommand: async () => false,
    getSlashCommands: () => [],
    registerBuiltinSlashCommand: () => {},
    getBuiltinSlashCommands: () => [],
    enablePlugin: async (_pluginId: string) => false,
    __executeMock: executeMock,
  };
}

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

/**
 * Build a fake DroneLlmCapability that wraps the given provider.
 */
function makeLlmCapability(provider: DroneLlmProvider): DroneLlmCapability {
  return {
    getActiveProvider: () => provider,
    getActiveProviderId: () => 'test-provider',
    getModel: () => 'fake',
    setModel: () => {},
    listModels: async () => ['fake'],
    registerProvider: () => {},
    unregisterProvider: () => {},
  };
}

// ---------------------------------------------------------------------------
// Step 5, test 3-5: Conversation service tool call limit resolution
// ---------------------------------------------------------------------------

describe('createConversationService — persona toolCallLimit', () => {
  function makePersonaCap(limit: number | undefined): {
    getActivePersona: () => { toolCallLimit?: number } | null;
    getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  } {
    return {
      getActivePersona: () =>
        limit !== undefined
          ? { toolCallLimit: limit }
          : { toolCallLimit: undefined },
      getFilteredTools: (tools: DroneToolDescriptor[]) => tools,
    };
  }

  function makeNullPersonaCap(): {
    getActivePersona: () => { toolCallLimit?: number } | null;
    getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  } {
    return {
      getActivePersona: () => null,
      getFilteredTools: (tools: DroneToolDescriptor[]) => tools,
    };
  }

  function makeErrnoEngine(personaCap?: {
    getActivePersona: () => { toolCallLimit?: number } | null;
    getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  }): DronePluginEngine & { __executeMock: ReturnType<typeof vi.fn> } {
    return makeEngine({
      tools: [
        {
          name: 'file.list',
          description: 'list',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => {
        const e: NodeJS.ErrnoException = new Error('not found');
        e.code = 'ENOENT';
        throw e;
      },
      personaCap,
    });
  }

  it('uses persona toolCallLimit when active persona has it set', async () => {
    const personaCap = makePersonaCap(5);
    const engine = makeErrnoEngine(personaCap);
    // Queue more tool-call responses than the persona limit (5) but fewer
    // than the config default (50), so the persona limit is what trips.
    const responses: DroneChatResponse[] = Array.from({ length: 7 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file.list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 50; // would never fire on its own
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      stuckErrorThreshold: 100,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => {
      if (id === 'llm') return makeLlmCapability(provider);
      if (id === 'persona') return personaCap;
      return undefined;
    };

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 5/
    );
  });

  it('falls back to config when persona has no toolCallLimit', async () => {
    const personaCap = makePersonaCap(undefined);
    const engine = makeErrnoEngine(personaCap);
    const responses: DroneChatResponse[] = Array.from({ length: 5 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file.list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 3;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      stuckErrorThreshold: 100,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => {
      if (id === 'llm') return makeLlmCapability(provider);
      if (id === 'persona') return personaCap;
      return undefined;
    };

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 3/
    );
  });

  it('falls back to config when no persona is active', async () => {
    const personaCap = makeNullPersonaCap();
    const engine = makeErrnoEngine(personaCap);
    const responses: DroneChatResponse[] = Array.from({ length: 5 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file.list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 3;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      stuckErrorThreshold: 100,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => {
      if (id === 'llm') return makeLlmCapability(provider);
      if (id === 'persona') return personaCap;
      return undefined;
    };

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 3/
    );
  });

  it('falls back to config when persona capability is absent', async () => {
    // No personaCap at all — engine.getCapability('persona') returns undefined
    const engine = makeErrnoEngine(undefined);
    const responses: DroneChatResponse[] = Array.from({ length: 5 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file.list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 3;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      stuckErrorThreshold: 100,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => {
      if (id === 'llm') return makeLlmCapability(provider);
      // No persona capability registered
      return undefined;
    };

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 3/
    );
  });

  it('constructor maxToolIterations still takes precedence over config when no persona limit', async () => {
    const personaCap = makeNullPersonaCap();
    const engine = makeErrnoEngine(personaCap);
    const responses: DroneChatResponse[] = Array.from({ length: 10 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file.list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 50; // would never fire
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      maxToolIterations: 2,
      stuckErrorThreshold: 100,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => {
      if (id === 'llm') return makeLlmCapability(provider);
      if (id === 'persona') return personaCap;
      return undefined;
    };

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 2/
    );
  });
});

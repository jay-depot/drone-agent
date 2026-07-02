import { describe, expect, it, vi } from 'vitest';
import type {
  DroneConversationEvent,
  DroneLlmCapability,
  DroneLlmProviderRegistration,
  DronePluginRegistration,
  DroneSessionSafetyTrimPayload,
  DroneSlashCommand,
  DroneSlashCommandContext,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { llmPlugin } from '../src/plugins/llm/index.js';
import { silentLogger } from './helpers.js';

type HookBucket = {
  onPluginsLoaded: Array<() => Promise<void>>;
  onSessionStart: Array<() => Promise<void>>;
  onBeforePrompt: Array<() => Promise<void>>;
  onAfterToolCall: Array<() => Promise<void>>;
  onConversationEvent: Array<(event: DroneConversationEvent) => Promise<void>>;
  onSessionClear: Array<() => Promise<void>>;
  onShutdown: Array<() => Promise<void>>;
  onSessionSafetyTrimWillRun: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  >;
  onSessionSafetyTrimApplied: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  >;
};

type Capture = {
  capability: DroneLlmCapability;
  modelCommand: DroneSlashCommand;
  hooks: HookBucket;
};

async function captureLlmPlugin(): Promise<Capture> {
  const config = createDefaultAgentConfig();
  const hooks: HookBucket = {
    onPluginsLoaded: [],
    onSessionStart: [],
    onBeforePrompt: [],
    onAfterToolCall: [],
    onConversationEvent: [],
    onSessionClear: [],
    onShutdown: [],
    onSessionSafetyTrimWillRun: [],
    onSessionSafetyTrimApplied: [],
  };

  let offeredCapability: DroneLlmCapability | undefined;
  let modelCommand: DroneSlashCommand | undefined;

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => config,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: command => {
      if (command.command === '/model') {
        modelCommand = command;
      }
    },
    hooks: {
      onPluginsLoaded: cb => hooks.onPluginsLoaded.push(cb),
      onSessionStart: cb => hooks.onSessionStart.push(cb),
      onBeforePrompt: cb => hooks.onBeforePrompt.push(cb),
      onAfterToolCall: cb => hooks.onAfterToolCall.push(cb),
      onConversationEvent: cb => hooks.onConversationEvent.push(cb),
      onSessionClear: cb => hooks.onSessionClear.push(cb),
      onShutdown: cb => hooks.onShutdown.push(cb),
      onSessionSafetyTrimWillRun: cb =>
        hooks.onSessionSafetyTrimWillRun.push(cb),
      onSessionSafetyTrimApplied: cb =>
        hooks.onSessionSafetyTrimApplied.push(cb),
    },
    offer: cap => {
      offeredCapability = cap as DroneLlmCapability;
    },
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };

  await llmPlugin.register(registration);

  if (!offeredCapability) {
    throw new Error('Expected llm capability to be offered.');
  }
  if (!modelCommand) {
    throw new Error('Expected /model slash command to be registered.');
  }

  return {
    capability: offeredCapability,
    modelCommand,
    hooks,
  };
}

function makeProviderRegistration(options: {
  id: string;
  defaultModel: string;
  models: string[];
  precedence?: number;
}): DroneLlmProviderRegistration {
  return {
    id: options.id,
    precedence: options.precedence ?? 1000,
    getProvider: () => ({
      chat: async () => ({ message: 'ok' }),
      getContextWindowInfo: async () => null,
    }),
    listModels: async () => options.models,
    getDefaultModel: () => options.defaultModel,
  };
}

function makeCommandContext(
  capability: DroneLlmCapability
): DroneSlashCommandContext {
  return {
    line: '/model',
    args: [],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    engine: {
      executeTool: async () => '',
      runHooks: async () => {},
      getCapability: <T>() => capability as T,
    },
    conversation: {
      getModel: () => capability.getModel(),
      setModel: (model: string) => capability.setModel(model),
      sendUserMessage: async () => '',
      enqueueUserMessage: (p: string) => {},
      cancelCurrentRequest: () => {},
    },
  };
}

describe('llm plugin provider switching', () => {
  it('lists providers and switches provider via capability', async () => {
    const { capability } = await captureLlmPlugin();

    capability.registerProvider(
      makeProviderRegistration({
        id: 'ollama',
        defaultModel: 'llama3.1',
        models: ['llama3.1'],
      })
    );
    capability.registerProvider(
      makeProviderRegistration({
        id: 'openrouter',
        defaultModel: 'openai/gpt-4o',
        models: ['openai/gpt-4o'],
      })
    );

    expect(capability.getActiveProviderId()).toBe('ollama');
    expect(capability.getModel()).toBe('llama3.1');
    expect(capability.getAvailableProviders()).toEqual([
      { id: 'ollama', precedence: 1000 },
      { id: 'openrouter', precedence: 1000 },
    ]);

    capability.activateProvider('openrouter');
    expect(capability.getActiveProviderId()).toBe('openrouter');
    expect(capability.getModel()).toBe('openai/gpt-4o');
  });

  it('throws a clear error when provider id is unknown', async () => {
    const { capability } = await captureLlmPlugin();

    capability.registerProvider(
      makeProviderRegistration({
        id: 'ollama',
        defaultModel: 'llama3.1',
        models: ['llama3.1'],
      })
    );

    expect(() => capability.activateProvider('missing')).toThrow(
      'LLM provider "missing" is not registered. Available: ollama'
    );
  });

  it('switches provider from /model --provider and resets to provider default', async () => {
    const { capability, modelCommand } = await captureLlmPlugin();

    capability.registerProvider(
      makeProviderRegistration({
        id: 'ollama',
        defaultModel: 'llama3.1',
        models: ['llama3.1'],
      })
    );
    capability.registerProvider(
      makeProviderRegistration({
        id: 'openrouter',
        defaultModel: 'openai/gpt-4o',
        models: ['openai/gpt-4o'],
      })
    );

    const ctx = makeCommandContext(capability);
    const conversationSetModel = vi.fn((model: string) =>
      capability.setModel(model)
    );
    ctx.conversation = {
      getModel: () => capability.getModel(),
      setModel: conversationSetModel,
      sendUserMessage: async () => '',
      enqueueUserMessage: (p: string) => {},
      cancelCurrentRequest: () => {},
    };
    ctx.line = '/model --provider openrouter';
    ctx.args = ['--provider', 'openrouter'];

    const handled = await modelCommand.handler(ctx);

    expect(handled).toBe(true);
    expect(capability.getActiveProviderId()).toBe('openrouter');
    expect(capability.getModel()).toBe('openai/gpt-4o');
    expect(conversationSetModel).toHaveBeenCalledWith('openai/gpt-4o');
  });

  it('fails fast when selecting a model unavailable on the active provider', async () => {
    const { capability, modelCommand } = await captureLlmPlugin();

    capability.registerProvider(
      makeProviderRegistration({
        id: 'ollama',
        defaultModel: 'llama3.1',
        models: ['llama3.1'],
      })
    );

    const ctx = makeCommandContext(capability);
    const conversationSetModel = vi.fn((model: string) =>
      capability.setModel(model)
    );
    ctx.conversation = {
      getModel: () => capability.getModel(),
      setModel: conversationSetModel,
      sendUserMessage: async () => '',
      enqueueUserMessage: (p: string) => {},
      cancelCurrentRequest: () => {},
    };
    ctx.line = '/model not-real';
    ctx.args = ['not-real'];

    const handled = await modelCommand.handler(ctx);

    expect(handled).toBe(true);
    expect(capability.getModel()).toBe('llama3.1');
    expect(conversationSetModel).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('supports /model --provider <id> <model> in one command', async () => {
    const { capability, modelCommand } = await captureLlmPlugin();

    capability.registerProvider(
      makeProviderRegistration({
        id: 'ollama',
        defaultModel: 'llama3.1',
        models: ['llama3.1'],
      })
    );
    capability.registerProvider(
      makeProviderRegistration({
        id: 'openrouter',
        defaultModel: 'openai/gpt-4o',
        models: ['openai/gpt-4o', 'openai/gpt-4.1'],
      })
    );

    const ctx = makeCommandContext(capability);
    const conversationSetModel = vi.fn((model: string) =>
      capability.setModel(model)
    );
    ctx.conversation = {
      getModel: () => capability.getModel(),
      setModel: conversationSetModel,
      sendUserMessage: async () => '',
      enqueueUserMessage: (p: string) => {},
      cancelCurrentRequest: () => {},
    };
    ctx.line = '/model --provider openrouter openai/gpt-4.1';
    ctx.args = ['--provider', 'openrouter', 'openai/gpt-4.1'];

    const handled = await modelCommand.handler(ctx);

    expect(handled).toBe(true);
    expect(capability.getActiveProviderId()).toBe('openrouter');
    expect(capability.getModel()).toBe('openai/gpt-4.1');
    expect(conversationSetModel).toHaveBeenLastCalledWith('openai/gpt-4.1');
  });
});

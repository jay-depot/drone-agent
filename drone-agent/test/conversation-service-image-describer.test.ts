import { describe, expect, it, vi } from 'vitest';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import {
  createDefaultAgentConfig,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneImageContent,
  type DroneLlmCapability,
  type DroneLlmProvider,
} from 'drone-core';
import { createConversationService } from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import type { ContextBudgetService } from '../src/runtime/context-budget-service.js';
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

function makeBudgetService(provider: DroneLlmProvider): ContextBudgetService {
  return createContextBudgetService({
    config: createDefaultAgentConfig(),
    renderPromptFragments: async () => [],
    getProvider: () => provider,
    getModel: () => 'fake',
  });
}

type LlmOverrides = {
  hasVision?: boolean;
  describeImages?: (
    images: DroneImageContent[]
  ) => Promise<DroneImageContent[]>;
  supportsImagesInToolResults?: boolean;
};

function makeLlmCapability(
  provider: DroneLlmProvider,
  overrides: LlmOverrides = {}
): DroneLlmCapability {
  const describeImages =
    overrides.describeImages ?? (async (images: DroneImageContent[]) => images);
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
    hasVision: () => overrides.hasVision ?? false,
    describeImages,
  };
}

type Harness = {
  conversation: ReturnType<typeof createConversationService>;
  provider: ReturnType<typeof makeProvider>;
  llm: DroneLlmCapability;
  sessionManager: ReturnType<typeof createSessionManager>;
  send: (prompt: string) => Promise<string>;
};

async function setup(options: {
  chatResponses: DroneChatResponse[];
  llmOverrides?: LlmOverrides;
  logEnabled?: boolean;
  swarmActive?: boolean;
}): Promise<Harness> {
  const engine = createMockEngine({
    tools: [
      {
        name: 'read_image',
        description: 'read an image',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ],
    executeToolImpl: async () =>
      JSON.stringify({
        path: '/tmp/test.png',
        mimeType: 'image/png',
        data: 'base64data',
        size: 100,
      }),
  });
  const provider = makeProvider(options.chatResponses);
  const llm = makeLlmCapability(provider, options.llmOverrides);
  const config = createDefaultAgentConfig();
  if (options.logEnabled !== undefined) config.log.enabled = options.logEnabled;
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
  ) => {
    if (id === 'llm') return llm;
    if (id === 'swarm' && options.swarmActive)
      return { getBeaconUrl: () => '' };
    return undefined;
  };
  const send = (prompt: string) => conversation.sendUserMessage(prompt);
  return { conversation, provider, llm, sessionManager, send };
}

describe('conversation-service image describer (request seam)', () => {
  it('describes images lazily when the target model is non-vision', async () => {
    const describeImages = vi.fn(async (images: DroneImageContent[]) =>
      images.map(img => ({ ...img, description: 'a screenshot' }))
    );
    const h = await setup({
      chatResponses: [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_image',
              arguments: { path: '/tmp/test.png' },
            },
          ],
        },
        { message: 'done' },
      ],
      llmOverrides: { hasVision: false, describeImages },
      logEnabled: false,
    });
    await h.send('look at this');
    // The describer should have been invoked once (lazy, once-cached).
    expect(describeImages).toHaveBeenCalledTimes(1);
    // The stored user message (image appended as a user message) should carry
    // the description.
    const messages = h.sessionManager.getMessages();
    const userMsg = messages.find(m => m.role === 'user' && m.images);
    expect(userMsg?.images?.[0].description).toBe('a screenshot');
  });

  it('describes across a multi-tool batch in parallel (D1 Promise.all)', async () => {
    // Two tool calls in one batch, each producing an image. With the
    // durability gate on, the eager describe at append must run the two
    // describe calls concurrently (Promise.all), not serially.
    let active = 0;
    let maxActive = 0;
    const describeImages = vi.fn(async (images: DroneImageContent[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return images.map(img => ({ ...img, description: 'parallel desc' }));
    });
    const h = await setup({
      chatResponses: [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_image',
              arguments: { path: '/tmp/a.png' },
            },
            {
              id: 'call-2',
              name: 'read_image',
              arguments: { path: '/tmp/b.png' },
            },
          ],
        },
        { message: 'done' },
      ],
      llmOverrides: { hasVision: true, describeImages },
      logEnabled: true,
    });
    await h.send('look at these');
    // Two separate describe calls (one per tool result), run concurrently.
    expect(describeImages).toHaveBeenCalledTimes(2);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('does NOT describe when the target model is vision-capable (unless durability gate)', async () => {
    const describeImages = vi.fn(async (images: DroneImageContent[]) => images);
    const h = await setup({
      chatResponses: [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_image',
              arguments: { path: '/tmp/test.png' },
            },
          ],
        },
        { message: 'done' },
      ],
      llmOverrides: { hasVision: true, describeImages },
      logEnabled: false,
    });
    await h.send('look at this');
    expect(describeImages).not.toHaveBeenCalled();
  });

  it('eagerly describes at append when the durability gate is on (log enabled)', async () => {
    const describeImages = vi.fn(async (images: DroneImageContent[]) =>
      images.map(img => ({ ...img, description: 'persisted desc' }))
    );
    const h = await setup({
      chatResponses: [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_image',
              arguments: { path: '/tmp/test.png' },
            },
          ],
        },
        { message: 'done' },
      ],
      llmOverrides: { hasVision: true, describeImages },
      logEnabled: true,
    });
    await h.send('look at this');
    // Durability gate forces eager describe even for vision targets.
    expect(describeImages).toHaveBeenCalledTimes(1);
    const messages = h.sessionManager.getMessages();
    const userMsg = messages.find(m => m.role === 'user' && m.images);
    expect(userMsg?.images?.[0].description).toBe('persisted desc');
  });

  it('eagerly describes at append when swarm is active', async () => {
    const describeImages = vi.fn(async (images: DroneImageContent[]) =>
      images.map(img => ({ ...img, description: 'swarm desc' }))
    );
    const h = await setup({
      chatResponses: [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_image',
              arguments: { path: '/tmp/test.png' },
            },
          ],
        },
        { message: 'done' },
      ],
      llmOverrides: { hasVision: true, describeImages },
      swarmActive: true,
    });
    await h.send('look at this');
    expect(describeImages).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: second send reuses the stored description', async () => {
    const describeImages = vi.fn(async (images: DroneImageContent[]) =>
      images.map(img => ({ ...img, description: 'cached desc' }))
    );
    const h = await setup({
      chatResponses: [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_image',
              arguments: { path: '/tmp/test.png' },
            },
          ],
        },
        { message: 'first' },
        { message: 'second' },
      ],
      llmOverrides: { hasVision: false, describeImages },
      logEnabled: false,
    });
    await h.send('look at this');
    await h.send('again');
    // Only the first send should have described (once-cached).
    expect(describeImages).toHaveBeenCalledTimes(1);
  });

  it('fails open: describer failure leaves the image undescribed', async () => {
    const describeImages = vi.fn(async () => {
      throw new Error('describer down');
    });
    const h = await setup({
      chatResponses: [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_image',
              arguments: { path: '/tmp/test.png' },
            },
          ],
        },
        { message: 'done' },
      ],
      llmOverrides: { hasVision: false, describeImages },
      logEnabled: false,
    });
    await h.send('look at this');
    const messages = h.sessionManager.getMessages();
    const userMsg = messages.find(m => m.role === 'user' && m.images);
    expect(userMsg?.images?.[0].description).toBeUndefined();
  });
});

describe('conversation-service presentation stripping (D11)', () => {
  it('non-vision target receives the description in content, image omitted', async () => {
    const describeImages = vi.fn(async (images: DroneImageContent[]) =>
      images.map(img => ({ ...img, description: 'a red circle' }))
    );
    const h = await setup({
      chatResponses: [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_image',
              arguments: { path: '/tmp/test.png' },
            },
          ],
        },
        { message: 'done' },
      ],
      llmOverrides: { hasVision: false, describeImages },
      logEnabled: false,
    });
    await h.send('look at this');
    // The provider.chat() request for the non-vision target should carry the
    // description in content and omit the image.
    const lastChat = h.provider.__chatMock.mock.calls.at(-1)?.[0];
    const userMsg = lastChat.messages.find(
      (m: { role: string; content: string }) =>
        m.role === 'user' && m.content.includes('a red circle')
    );
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toContain('a red circle');
    expect(userMsg.images).toBeUndefined();
  });

  it('vision target receives the image via images[] and blob stripped from content', async () => {
    const h = await setup({
      chatResponses: [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_image',
              arguments: { path: '/tmp/test.png' },
            },
          ],
        },
        { message: 'done' },
      ],
      llmOverrides: { hasVision: true },
      logEnabled: false,
    });
    await h.send('look at this');
    const lastChat = h.provider.__chatMock.mock.calls.at(-1)?.[0];
    const userMsg = lastChat.messages.find(
      (m: { role: string; images?: unknown }) => m.role === 'user' && m.images
    );
    expect(userMsg).toBeDefined();
    expect(userMsg.images).toHaveLength(1);
    // The base64 blob should be stripped from content (marker left).
    expect(userMsg.content).not.toContain('base64data');
  });
});

/**
 * Integration tests for `@`-reference expansion at the conversation-service
 * append sites. Uses a real conversation service (mock engine/provider) with an
 * injected `expandUserMessage`, so the expansion contract is exercised the way
 * every host (TUI, readline, swarm, macros) reaches it.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import {
  createDefaultAgentConfig,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneConversationEvent,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DroneReferenceCapability,
  type DroneReferenceExpansion,
} from 'drone-core';
import {
  CANCEL_SENTINEL,
  createConversationService,
} from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { createReferenceCapability } from '../src/runtime/reference-expansion/index.js';
import { createMockEngine, silentLogger } from './helpers.js';
import { macrosPlugin } from '../src/plugins/macros/index.js';

// ---------------------------------------------------------------------------
// Fixtures (mirrors conversation-service-steering.test.ts)
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

/** A counting expander that appends a `--- Referenced content ---` trailer. */
function makeExpander(): {
  expand: (text: string) => Promise<DroneReferenceExpansion>;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (text: string) => {
    if (!text.includes('@')) {
      return { text, images: [], notices: [] };
    }
    return {
      text: `${text}\n\n--- Referenced content ---\n### @fixture.ts\n\`\`\`ts\nbody\n\`\`\``,
      images: [],
      notices: ['[expanded @fixture.ts (1 lines, 4 B)]'],
    };
  });
  return { expand: spy, spy };
}

function makeConversation(
  provider: DroneLlmProvider,
  expandUserMessage: (text: string) => Promise<DroneReferenceExpansion>
) {
  const engine = createMockEngine({
    tools: [],
    executeToolImpl: async () => 'ok',
  });
  const config = createDefaultAgentConfig();
  const budgetService = createContextBudgetService({
    config,
    renderPromptFragments: async () => [],
    getProvider: () => provider,
    getModel: () => 'fake',
  });
  const sessionManager = createSessionManager();
  const conversation = createConversationService({
    engine: engine as unknown as DronePluginEngine,
    config,
    logger: silentLogger(),
    sessionManager,
    budgetService,
    expandUserMessage,
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

describe('reference expansion at the conversation service', () => {
  it('expands an idle sendUserMessage, emits a notice, and appends the trailer', async () => {
    const provider = makeProvider([{ message: 'done' }]);
    const { expand, spy } = makeExpander();
    const { conversation, events } = makeConversation(provider, expand);

    await conversation.sendUserMessage('look at @fixture.ts');

    const userTurn = conversation
      .getMessages()
      .find(m => m.role === 'user' && m.content.includes('@fixture.ts'));
    expect(userTurn?.content).toContain('--- Referenced content ---');
    expect(userTurn?.content).toContain('### @fixture.ts');
    // The `userMessage` event carries the EXPANDED text.
    const um = events.find(e => e.kind === 'userMessage');
    expect(um && 'content' in um && um.content).toContain(
      '--- Referenced content ---'
    );
    // A receipt notice was emitted.
    expect(
      events.some(e => e.kind === 'notice' && e.content.includes('[expanded'))
    ).toBe(true);
    expect(spy).toHaveBeenCalledWith('look at @fixture.ts');
  });

  it('leaves a message without `@` untouched', async () => {
    const provider = makeProvider([{ message: 'done' }]);
    const { expand, spy } = makeExpander();
    const conversation = makeConversation(provider, expand);
    await conversation.conversation.sendUserMessage('plain text');
    expect(spy).toHaveBeenCalledWith('plain text');
    const turn = conversation.conversation
      .getMessages()
      .find(m => m.role === 'user');
    expect(turn?.content).toBe('plain text');
  });

  it("expands deferred text at the 'append' drain (preserved across cancel)", async () => {
    const provider = makeProvider([{ message: 'never' }]);
    const { expand, spy } = makeExpander();
    const { conversation } = makeConversation(provider, expand);

    // Force a second iteration, then cancel so the queued text is preserved.
    const held = holdFirstChat(provider, toolCallResponse());
    const turn = conversation.sendUserMessage('first');
    await tick();
    conversation.enqueueUserMessage('queued @fixture.ts');
    conversation.cancelCurrentRequest();
    held.release();
    expect(await turn).toBe(CANCEL_SENTINEL);

    // The NEXT sendUserMessage drains the preserved entry via 'append'.
    await conversation.sendUserMessage('second');

    const drained = conversation
      .getMessages()
      .find(m => m.role === 'user' && m.content.includes('queued'));
    expect(drained?.content).toContain('--- Referenced content ---');
    expect(spy).toHaveBeenCalledWith('queued @fixture.ts');
  });

  it("expands a queued message EXACTLY ONCE via the 'own-round' drain", async () => {
    const provider = makeProvider([{ message: 'final' }]);
    const { expand, spy } = makeExpander();
    const { conversation } = makeConversation(provider, expand);

    // Hold the first call, enqueue text, then let the round complete normally
    // so the finally-drain runs the queued text as its own round.
    const held = holdFirstChat(provider, { message: 'first-done' });
    const turn = conversation.sendUserMessage('first');
    await tick();
    conversation.enqueueUserMessage('own @fixture.ts');
    held.release();
    await turn;
    // Give the async own-round send a tick to finish.
    await tick();

    // The expander must run once for the queued content — never twice (the
    // own-round drain re-enters sendUserMessage, which is the single site).
    const calls = spy.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('own @fixture.ts')
    );
    expect(calls).toHaveLength(1);

    const appended = conversation
      .getMessages()
      .filter(m => m.role === 'user' && m.content.includes('own @fixture.ts'));
    expect(appended).toHaveLength(1);
    expect(appended[0].content).toContain('--- Referenced content ---');
  });

  it('expands a mid-round /steer message at the steering append', async () => {
    const provider = makeProvider([{ message: 'final' }]);
    const { expand, spy } = makeExpander();
    const { conversation } = makeConversation(provider, expand);

    const held = holdFirstChat(provider, toolCallResponse());
    const turn = conversation.sendUserMessage('first');
    await tick();
    await conversation.steerMessage('steer @fixture.ts');
    held.release();
    await turn;

    const steered = conversation
      .getMessages()
      .find(m => m.role === 'user' && m.content.includes('steer'));
    expect(steered?.content).toContain('--- Referenced content ---');
    expect(spy).toHaveBeenCalledWith('steer @fixture.ts');
  });
});

describe('macro chat-prompt steps route through expansion', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('expands an `@ref` inside a macro chat step argument', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ref-macro-'));
    await mkdir(path.join(dir, '.drone-agent', 'macros'), { recursive: true });
    await writeFile(
      path.join(dir, '.drone-agent', 'macros', 'look.macro'),
      '#! /look Look at something\nLook at $1\n',
      'utf-8'
    );

    // Capture the macro's slash-command handler via a minimal registration.
    const handlers = new Map<
      string,
      (ctx: Record<string, unknown>) => Promise<boolean>
    >();
    const originalCwd = process.cwd;
    process.cwd = () => dir!;
    try {
      await macrosPlugin.register({
        logger: silentLogger(),
        registerSlashCommand: (cmd: { command: string; handler: unknown }) =>
          handlers.set(
            cmd.command,
            cmd.handler as (ctx: Record<string, unknown>) => Promise<boolean>
          ),
        registerHelp: () => {},
        registerWorkflow: () => {},
        offer: () => {},
        emitEvent: () => {},
        getConfig: () => createDefaultAgentConfig(),
      } as unknown as Parameters<typeof macrosPlugin.register>[0]);
    } finally {
      process.cwd = originalCwd;
    }

    const provider = makeProvider([{ message: 'done' }]);
    const { expand } = makeExpander();
    const { conversation } = makeConversation(provider, expand);

    const handler = handlers.get('/look');
    expect(handler).toBeDefined();
    const handled = await handler!({
      args: ['@fixture.ts'],
      logger: silentLogger(),
      engine: {
        runHooks: async () => {},
        dispatchSlashCommand: async () => true,
      },
      conversation,
      sessionManager: conversation,
    });
    expect(handled).toBe(true);

    const turn = conversation
      .getMessages()
      .find(m => m.role === 'user' && m.content.includes('@fixture.ts'));
    expect(turn?.content).toContain('Look at @fixture.ts');
    expect(turn?.content).toContain('--- Referenced content ---');
  });
});

describe('host wiring: the engine capability is the default expander', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  function makeHostConversation(
    provider: DroneLlmProvider,
    capability: DroneReferenceCapability | undefined
  ) {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => 'ok',
    });
    const config = createDefaultAgentConfig();
    const budgetService = createContextBudgetService({
      config,
      renderPromptFragments: async () => [],
      getProvider: () => provider,
      getModel: () => 'fake',
    });
    const sessionManager = createSessionManager();
    // No `expandUserMessage` — the host must resolve it from the capability.
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
      if (id === 'llm') return makeLlmCapability(provider);
      if (id === 'reference') return capability;
      return undefined;
    };
    const events: DroneConversationEvent[] = [];
    engine.runConversationEventHooks = async event => {
      events.push(event);
    };
    return { conversation, engine, events };
  }

  it('inlines a real @file reference with no expandUserMessage option', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ref-host-'));
    await writeFile(path.join(dir, 'notes.md'), 'hello from disk\n', 'utf-8');
    const provider = makeProvider([{ message: 'done' }]);
    const capability = createReferenceCapability({ cwd: dir, homedir: dir });
    const { conversation, events } = makeHostConversation(provider, capability);

    await conversation.sendUserMessage('see @notes.md');

    const turn = conversation.getMessages().find(m => m.role === 'user');
    expect(turn?.content).toContain('--- Referenced content ---');
    expect(turn?.content).toContain('hello from disk');
    // The success receipt is emitted by the REAL capability (never mocked here).
    expect(
      events.some(
        e =>
          e.kind === 'notice' &&
          e.content === '[expanded @notes.md (1 lines, 16 B)]'
      )
    ).toBe(true);
  });

  it('falls back to identity when no reference capability is registered', async () => {
    const provider = makeProvider([{ message: 'done' }]);
    const { conversation } = makeHostConversation(provider, undefined);

    await conversation.sendUserMessage('see @notes.md');

    const turn = conversation.getMessages().find(m => m.role === 'user');
    expect(turn?.content).toBe('see @notes.md');
  });

  it('attaches an image reference to the SESSION user turn (end to end)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ref-host-img-'));
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    await writeFile(path.join(dir, 'pic.png'), png);
    const provider = makeProvider([{ message: 'done' }]);
    const capability = createReferenceCapability({ cwd: dir, homedir: dir });
    const { conversation, events } = makeHostConversation(provider, capability);

    await conversation.sendUserMessage('describe @pic.png');

    const turn = conversation
      .getMessages()
      .find(m => m.role === 'user' && m.content.includes('@pic.png'));
    // The seam is live: the image reached the session store, not just the
    // expansion result, and no text block was appended.
    expect(turn?.images).toHaveLength(1);
    expect(turn?.images?.[0].mimeType).toBe('image/png');
    expect(turn?.images?.[0].data).toBe(png.toString('base64'));
    expect(turn?.content).toBe('describe @pic.png');
    expect(turn?.content).not.toContain('--- Referenced content ---');
    expect(turn?.content).not.toContain('[skipped binary');
    // The real capability emitted the image receipt.
    expect(
      events.some(
        e =>
          e.kind === 'notice' &&
          e.content === `[expanded @pic.png (image/png, ${png.length} B)]`
      )
    ).toBe(true);
  });

  it('caps user-turn images to maxImagesPerMessage with the reference marker', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ref-host-cap-'));
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    for (let i = 0; i < 25; i++) {
      await writeFile(
        path.join(dir, `p${String(i).padStart(2, '0')}.png`),
        png
      );
    }
    const provider = makeProvider([{ message: 'done' }]);
    const capability = createReferenceCapability({ cwd: dir, homedir: dir });
    const { conversation } = makeHostConversation(provider, capability);

    await conversation.sendUserMessage('look at @*.png');

    const turn = conversation
      .getMessages()
      .find(m => m.role === 'user' && m.content.includes('@*.png'));
    expect(turn?.images).toHaveLength(20);
    expect(turn?.content).toContain(
      '[5 additional images omitted. Retrieve them individually if needed.]'
    );
  });
});

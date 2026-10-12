import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultAgentConfig,
  type DroneConversationEvent,
} from 'drone-core';

import { createSessionManager } from '../src/runtime/session-manager.js';
import { createTestEngine, createTestPlugin, silentLogger } from './helpers.js';

describe('engine.clearSession session boundary', () => {
  it('runs onSessionClear (session intact) → clear → mint → onSessionRecycle', async () => {
    const sessionManager = createSessionManager();
    const order: string[] = [];
    let clearObservedTurns = -1;

    const engine = createTestEngine({
      plugins: [
        createTestPlugin({
          id: 'probe',
          defaultEnabled: true,
          hooks: {
            onSessionClear: async () => {
              order.push('clear-hook');
              clearObservedTurns = sessionManager.getTurns().length;
            },
            onSessionRecycle: async () => {
              order.push('recycle-hook');
            },
          },
        }),
      ],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      sessionId: 'old-session',
      sessionManager,
      clearConversation: () => {
        order.push('mechanical-clear');
        sessionManager.clearSession();
      },
    });
    await engine.initialize();

    sessionManager.appendUserMessage('a turn');
    await engine.clearSession();

    expect(order).toEqual(['clear-hook', 'mechanical-clear', 'recycle-hook']);
    // onSessionClear saw the outgoing session intact.
    expect(clearObservedTurns).toBe(1);
    // A fresh id was minted.
    expect(engine.getSessionId()).not.toBe('old-session');
    // The session was emptied.
    expect(sessionManager.getTurns()).toHaveLength(0);
  });

  it('passes ids to the recycle hook and mints a new one', async () => {
    const sessionManager = createSessionManager();
    const recyclePayloads: Array<{
      sessionId: string;
      previousSessionId: string;
    }> = [];
    const engine = createTestEngine({
      plugins: [
        createTestPlugin({
          id: 'probe',
          defaultEnabled: true,
          hooks: {
            onSessionRecycle: async payload => {
              recyclePayloads.push(payload);
            },
          },
        }),
      ],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      sessionId: 'seed-id',
      sessionManager,
      clearConversation: () => sessionManager.clearSession(),
    });
    await engine.initialize();
    sessionManager.appendUserMessage('x');
    await engine.clearSession();

    expect(recyclePayloads).toHaveLength(1);
    expect(recyclePayloads[0].previousSessionId).toBe('seed-id');
    expect(recyclePayloads[0].sessionId).toBe(engine.getSessionId());
    expect(recyclePayloads[0].sessionId).not.toBe('seed-id');
  });

  it('empty session: mechanical clear only, no hooks, no mint', async () => {
    const sessionManager = createSessionManager();
    const clearHook = vi.fn();
    const recycleHook = vi.fn();
    const engine = createTestEngine({
      plugins: [
        createTestPlugin({
          id: 'probe',
          defaultEnabled: true,
          hooks: {
            onSessionClear: clearHook,
            onSessionRecycle: recycleHook,
          },
        }),
      ],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      sessionId: 'keep-id',
      sessionManager,
      clearConversation: () => sessionManager.clearSession(),
    });
    await engine.initialize();

    await engine.clearSession();

    expect(clearHook).not.toHaveBeenCalled();
    expect(recycleHook).not.toHaveBeenCalled();
    expect(engine.getSessionId()).toBe('keep-id');
  });

  it('honors a host-seeded session id', async () => {
    const engine = createTestEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      sessionId: 'host-seeded',
    });
    await engine.initialize();
    expect(engine.getSessionId()).toBe('host-seeded');
  });

  it('falls back to agent-<ts> when no id is seeded', async () => {
    const engine = createTestEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();
    expect(engine.getSessionId()).toMatch(/^agent-/);
  });

  it('seeds the portable-context capability before plugin registration', async () => {
    let seenAtRegister: unknown;
    const engine = createTestEngine({
      plugins: [
        createTestPlugin({
          id: 'probe',
          defaultEnabled: true,
          dependencies: [{ id: 'portable-context', optional: true }],
          register: registration => {
            seenAtRegister = registration.request('portable-context');
          },
        }),
      ],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();
    expect(seenAtRegister).toBeDefined();
    expect(engine.getCapability('portable-context')).toBe(seenAtRegister);
  });

  it('emits the import notice into the engine event stream', async () => {
    const events: DroneConversationEvent[] = [];
    const engine = createTestEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    engine.onConversationEvent(event => events.push(event));
    await engine.initialize();
    const capability = engine.getCapability<{
      importContext: (data: unknown) => Promise<unknown>;
    }>('portable-context');
    await capability?.importContext({
      version: 1,
      createdAt: new Date().toISOString(),
      session: { sourceSessionId: 's', turns: [] },
      tools: [],
      pluginData: {},
    });
    expect(events.some(e => e.kind === 'notice')).toBe(true);
  });
});

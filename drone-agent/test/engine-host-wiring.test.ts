import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig,
  type DronePortableContextCapability,
} from 'drone-core';

import { createSessionManager } from '../src/runtime/session-manager.js';
import { createTestEngine, silentLogger } from './helpers.js';

/**
 * Guards the production host wiring that `index.tsx` performs: the engine must
 * receive the real session manager and the host-seeded session id, so the
 * engine-seeded `portable-context` capability exports the live session's turns
 * and its real id. The `/clear` and recycle behavior is covered by
 * `portable-context-engine.test.ts`.
 */
describe('engine host wiring — portable-context export path', () => {
  it('exports the turns of the host session manager', async () => {
    const sessionManager = createSessionManager();
    const engine = createTestEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      sessionId: 'host-id',
      sessionManager,
    });
    await engine.initialize();

    sessionManager.appendUserMessage('hello');

    const capability =
      engine.getCapability<DronePortableContextCapability>('portable-context');
    const exported = await capability!.exportContext();

    expect(exported.session.turns).toHaveLength(1);
    expect(exported.session.sourceSessionId).toBe('host-id');
  });

  it('flows the host-seeded session id through getSessionId and the export', async () => {
    const engine = createTestEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      sessionId: 'host-id',
    });
    await engine.initialize();

    expect(engine.getSessionId()).toBe('host-id');

    const capability =
      engine.getCapability<DronePortableContextCapability>('portable-context');
    const exported = await capability!.exportContext();
    expect(exported.session.sourceSessionId).toBe('host-id');
  });

  it('leaves the exported turns empty only when the session is empty', async () => {
    const engine = createTestEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();

    const capability =
      engine.getCapability<DronePortableContextCapability>('portable-context');
    const exported = await capability!.exportContext();
    expect(exported.session.turns).toHaveLength(0);
  });
});

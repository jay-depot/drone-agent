import { describe, expect, it, vi } from 'vitest';
import { SurfaceRegistry } from '../src/surfaces/registry.js';
import { registerBuiltInSurfaces } from '../src/surfaces/builtins.js';
import type { SurfaceFactory } from '../src/surfaces/types.js';

const noopFactory: SurfaceFactory = (_spec, conversationId) => ({
  id: `noop-${conversationId}`,
  type: 'noop',
  handleMessage: async () => ({ response: null, handled: true }),
});

describe('SurfaceRegistry', () => {
  it('registers and retrieves a factory', () => {
    const registry = new SurfaceRegistry();
    registry.register('noop', noopFactory);
    expect(registry.get('noop')).toBe(noopFactory);
  });

  it('returns undefined for an unknown type', () => {
    expect(new SurfaceRegistry().get('nope')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const registry = new SurfaceRegistry();
    registry.register('noop', noopFactory);
    expect(() => registry.register('noop', noopFactory)).toThrow(
      'Duplicate control surface type: noop'
    );
  });

  it('lists registered types sorted', () => {
    const registry = new SurfaceRegistry();
    registry.register('zeta', noopFactory);
    registry.register('alpha', noopFactory);
    expect(registry.types()).toEqual(['alpha', 'zeta']);
  });
});

describe('registerBuiltInSurfaces', () => {
  it('registers every built-in surface type', () => {
    const registry = new SurfaceRegistry();
    registerBuiltInSurfaces(registry);
    expect(registry.types()).toEqual([
      'discard',
      'persona-assignment',
      'swarm-console',
    ]);
    expect(registry.get('persona-assignment')).toBeTypeOf('function');
    expect(registry.get('discard')).toBeTypeOf('function');
    expect(registry.get('swarm-console')).toBeTypeOf('function');
  });

  it('builds a discard surface returning handled:true with no response', async () => {
    const registry = new SurfaceRegistry();
    registerBuiltInSurfaces(registry);
    const factory = registry.get('discard')!;
    const surface = factory({ type: 'discard' }, 'conv-1', {
      spawnBackend: {} as never,
      swarm: undefined,
    });
    await expect(
      surface.handleMessage({
        adapterId: 'a',
        conversationId: 'conv-1',
        text: 'hi',
        conversationKind: 'dm',
      })
    ).resolves.toEqual({ response: null, handled: true });
    expect(surface.id).toBe('discard-conv-1');
  });

  it('throws when persona-assignment has no personaId', () => {
    const registry = new SurfaceRegistry();
    registerBuiltInSurfaces(registry);
    const factory = registry.get('persona-assignment')!;
    expect(() =>
      factory({ type: 'persona-assignment' }, 'conv-1', {
        spawnBackend: {} as never,
        swarm: undefined,
      })
    ).toThrow('persona-assignment control surface requires personaId');
  });

  it('persona-assignment spawns then sends a message', async () => {
    const spawnBackend = {
      spawnSession: vi.fn(async () => ({
        conversationId: 'conv-1',
        personaId: 'coder',
        processId: 'agent-1',
        startedAt: 0,
      })),
      sendMessage: vi.fn(async () => 'hello back'),
      terminateSession: vi.fn(),
      type: 'local' as const,
    };
    const registry = new SurfaceRegistry();
    registerBuiltInSurfaces(registry);
    const surface = registry.get('persona-assignment')!(
      { type: 'persona-assignment', personaId: 'coder' },
      'conv-1',
      { spawnBackend, swarm: undefined }
    );
    const result = await surface.handleMessage({
      adapterId: 'a',
      conversationId: 'conv-1',
      text: 'hi',
      conversationKind: 'dm',
    });
    expect(result).toEqual({ response: 'hello back', handled: true });
    expect(spawnBackend.spawnSession).toHaveBeenCalledWith('conv-1', 'coder', {
      targetBeaconId: undefined,
      workingDir: undefined,
    });
  });

  it('persona-assignment forwards the resolved target beacon', async () => {
    const spawnBackend = {
      spawnSession: vi.fn(async () => ({
        conversationId: 'conv-1',
        personaId: 'coder',
        processId: 'agent-1',
        startedAt: 0,
      })),
      sendMessage: vi.fn(async () => 'hello back'),
      terminateSession: vi.fn(),
      type: 'coordinator' as const,
    };
    const registry = new SurfaceRegistry();
    registerBuiltInSurfaces(registry);
    const surface = registry.get('persona-assignment')!(
      { type: 'persona-assignment', personaId: 'coder' },
      'conv-1',
      { spawnBackend, swarm: undefined, targetBeaconId: 'beacon-9' }
    );
    await surface.handleMessage({
      adapterId: 'a',
      conversationId: 'conv-1',
      text: 'hi',
      conversationKind: 'dm',
    });
    expect(spawnBackend.spawnSession).toHaveBeenCalledWith('conv-1', 'coder', {
      targetBeaconId: 'beacon-9',
      workingDir: undefined,
    });
  });

  it('persona-assignment reports spawn errors as a response', async () => {
    const spawnBackend = {
      spawnSession: vi.fn(async () => {
        throw new Error('boom');
      }),
      sendMessage: vi.fn(),
      terminateSession: vi.fn(),
      type: 'local' as const,
    };
    const registry = new SurfaceRegistry();
    registerBuiltInSurfaces(registry);
    const surface = registry.get('persona-assignment')!(
      { type: 'persona-assignment', personaId: 'coder' },
      'conv-1',
      { spawnBackend, swarm: undefined }
    );
    const result = await surface.handleMessage({
      adapterId: 'a',
      conversationId: 'conv-1',
      text: 'hi',
      conversationKind: 'dm',
    });
    expect(result).toEqual({ response: 'Error: boom', handled: true });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { SpawnBackendRegistry } from '../src/spawn-backend-registry.js';
import type { SpawnBackend } from '../src/spawn-backend.js';

function mockBackend(type: 'local' | 'coordinator'): SpawnBackend {
  return {
    type,
    spawnSession: vi.fn(),
    sendMessage: vi.fn(),
    terminateSession: vi.fn(),
  };
}

describe('SpawnBackendRegistry', () => {
  it('registers and retrieves a backend', () => {
    const registry = new SpawnBackendRegistry();
    const backend = mockBackend('local');
    registry.register('local', backend);
    expect(registry.get('local')).toBe(backend);
  });

  it('returns undefined for an unregistered type', () => {
    expect(new SpawnBackendRegistry().get('coordinator')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const registry = new SpawnBackendRegistry();
    registry.register('local', mockBackend('local'));
    expect(() => registry.register('local', mockBackend('local'))).toThrow(
      'Duplicate spawn backend: local'
    );
  });

  it('lists registered types sorted', () => {
    const registry = new SpawnBackendRegistry();
    registry.register('coordinator', mockBackend('coordinator'));
    registry.register('local', mockBackend('local'));
    expect(registry.types()).toEqual(['coordinator', 'local']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  SPAWNING_SURFACES,
  SURFACES_REQUIRING_COORDINATOR,
  resolveSurfaceSpawnMode,
} from '../src/surfaces/requirements.js';
import type { ControlSurfaceSpec } from '../src/types.js';

describe('SPAWNING_SURFACES', () => {
  it('contains exactly persona-assignment', () => {
    expect([...SPAWNING_SURFACES]).toEqual(['persona-assignment']);
  });
});

describe('SURFACES_REQUIRING_COORDINATOR', () => {
  it('contains exactly swarm-console', () => {
    expect([...SURFACES_REQUIRING_COORDINATOR]).toEqual(['swarm-console']);
  });
});

describe('resolveSurfaceSpawnMode', () => {
  function spec(config?: Record<string, unknown>): ControlSurfaceSpec {
    return { type: 'persona-assignment', personaId: 'me', config };
  }

  it('returns coordinator when targetBeaconId is a non-empty string', () => {
    expect(resolveSurfaceSpawnMode(spec({ targetBeaconId: 'beacon-9' }))).toBe(
      'coordinator'
    );
  });

  it('returns local when targetBeaconId is absent', () => {
    expect(resolveSurfaceSpawnMode(spec())).toBe('local');
    expect(resolveSurfaceSpawnMode(spec({}))).toBe('local');
  });

  it('returns local for an empty or whitespace targetBeaconId', () => {
    expect(resolveSurfaceSpawnMode(spec({ targetBeaconId: '' }))).toBe('local');
    expect(resolveSurfaceSpawnMode(spec({ targetBeaconId: '   ' }))).toBe(
      'local'
    );
  });

  it('returns local for a non-string targetBeaconId', () => {
    expect(resolveSurfaceSpawnMode(spec({ targetBeaconId: 42 }))).toBe('local');
  });
});

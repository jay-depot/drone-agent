import { describe, expect, it } from 'vitest';
import {
  BROADCAST_TARGET,
  validateFragmentId,
  type DroneSwarmFragment,
} from '../src/index.js';

describe('validateFragmentId', () => {
  it('accepts url-safe, prompt-display-safe ids', () => {
    expect(validateFragmentId('maintenance-window')).toBe(true);
    expect(validateFragmentId('BUILD:123')).toBe(true);
    expect(validateFragmentId('a_b-c')).toBe(true);
    expect(validateFragmentId('x')).toBe(true);
  });

  it('rejects empty ids and ids with disallowed characters', () => {
    expect(validateFragmentId('')).toBe(false);
    expect(validateFragmentId('has space')).toBe(false);
    expect(validateFragmentId('has/slash')).toBe(false);
    expect(validateFragmentId('has.dot')).toBe(false);
    expect(validateFragmentId('has#hash')).toBe(false);
    expect(validateFragmentId('has\nnewline')).toBe(false);
  });
});

describe('BROADCAST_TARGET', () => {
  it('is the reserved broadcast sentinel', () => {
    expect(BROADCAST_TARGET).toBe('broadcast');
  });
});

describe('DroneSwarmFragment shape', () => {
  it('round-trips through JSON with expiresAt nullable', () => {
    const fragment: DroneSwarmFragment = {
      id: 'maintenance-window',
      target: BROADCAST_TARGET,
      content: 'Collector is down.',
      phase: 'header',
      scope: 'local',
      createdAt: 1000,
      updatedAt: 2000,
      expiresAt: null,
    };
    const roundTripped = JSON.parse(
      JSON.stringify(fragment)
    ) as DroneSwarmFragment;
    expect(roundTripped).toEqual(fragment);
  });

  it('uses header phase and local scope defaults in constructed rows', () => {
    const fragment: DroneSwarmFragment = {
      id: 'a',
      target: 'agent-1',
      content: 'hello',
      phase: 'header',
      scope: 'local',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 999,
    };
    expect(fragment.phase).toBe('header');
    expect(fragment.scope).toBe('local');
  });
});
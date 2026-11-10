import { describe, expect, it } from 'vitest';
import { resolveDueAt, formatHuman } from '../src/schedule/invoke.js';

describe('resolveDueAt', () => {
  it('parses a valid ISO-8601 dueAt', () => {
    const result = resolveDueAt({ dueAt: '2030-01-02T03:04:05.000Z' });
    expect(result).toEqual({
      ok: true,
      dueAt: Date.parse('2030-01-02T03:04:05.000Z'),
    });
  });

  it('rejects an invalid dueAt', () => {
    const result = resolveDueAt({ dueAt: 'not-a-time' });
    expect(result).toEqual({
      ok: false,
      error: 'dueAt is not a valid ISO-8601 time',
    });
  });

  it('accepts delayMs as a relative alias', () => {
    const before = Date.now();
    const result = resolveDueAt({ delayMs: 60_000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dueAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(result.dueAt).toBeLessThanOrEqual(Date.now() + 60_000);
    }
  });

  it('prefers dueAt when both are given', () => {
    const result = resolveDueAt({
      dueAt: '2030-01-02T03:04:05.000Z',
      delayMs: 60_000,
    });
    expect(result).toEqual({
      ok: true,
      dueAt: Date.parse('2030-01-02T03:04:05.000Z'),
    });
  });

  it('rejects when neither is given', () => {
    expect(resolveDueAt({})).toEqual({
      ok: false,
      error: 'provide dueAt or delayMs',
    });
  });

  it('rejects a negative delayMs', () => {
    expect(resolveDueAt({ delayMs: -1 })).toEqual({
      ok: false,
      error: 'delayMs must not be negative',
    });
  });
});

describe('formatHuman', () => {
  it('reports a past instant as firing on the next tick', () => {
    expect(formatHuman(1_000, 2_000)).toBe(
      'in the past (fires on the next tick)'
    );
  });

  it('reports minutes under an hour', () => {
    expect(formatHuman(1_000_000, 1_000_000 - 5 * 60_000)).toBe(
      'in 5 minute(s)'
    );
  });

  it('reports hours and minutes above an hour', () => {
    expect(formatHuman(1_000_000, 1_000_000 - 90 * 60_000)).toBe('in 1h 30m');
  });
});

import { describe, it, expect } from 'vitest';
import { formatDuration, formatSessionDuration } from './duration';
import type { SessionDurationInput } from './duration';

describe('formatDuration', () => {
  it('formats zero as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats seconds under a minute', () => {
    expect(formatDuration(42_000)).toBe('42s');
  });

  it('formats whole minutes', () => {
    expect(formatDuration(1_020_000)).toBe('17m');
  });

  it('zero-pads minutes under an hour', () => {
    expect(formatDuration(11_100_000)).toBe('3h 05m');
  });

  it('zero-pads hours over a day', () => {
    expect(formatDuration(187_200_000)).toBe('2d 04h');
  });

  it('clamps negative input to 0s', () => {
    expect(formatDuration(-5_000)).toBe('0s');
  });

  it('shows unknown for NaN input', () => {
    expect(formatDuration(Number.NaN)).toBe('unknown');
  });

  it('shows unknown for infinite input', () => {
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});

describe('formatSessionDuration', () => {
  it('shows a frozen value when the end time is set', () => {
    expect(
      formatSessionDuration({ createdAt: 0, endedAt: 300_000, status: 'ended' })
    ).toBe('5m');
  });

  it('shows a ~-prefixed age for an active session', () => {
    expect(
      formatSessionDuration(
        { createdAt: 0, endedAt: null, status: 'active' },
        300_000
      )
    ).toBe('~5m');
  });

  it('treats stale as live', () => {
    expect(
      formatSessionDuration(
        { createdAt: 0, endedAt: null, status: 'stale' },
        300_000
      )
    ).toBe('~5m');
  });

  it('shows unknown for a non-live session without an end time', () => {
    expect(
      formatSessionDuration({
        createdAt: 0,
        endedAt: null,
        status: 'processing',
      })
    ).toBe('unknown');
  });

  it('treats an absent endedAt from a stale API as null for a live session', () => {
    const fromStaleApi = {
      createdAt: 0,
      endedAt: undefined,
      status: 'active',
    } as unknown as SessionDurationInput;
    expect(formatSessionDuration(fromStaleApi, 300_000)).toBe('~5m');
  });

  it('shows unknown for an absent endedAt on a non-live session', () => {
    const fromStaleApi = {
      createdAt: 0,
      endedAt: undefined,
      status: 'processing',
    } as unknown as SessionDurationInput;
    expect(formatSessionDuration(fromStaleApi, 300_000)).toBe('unknown');
  });
});

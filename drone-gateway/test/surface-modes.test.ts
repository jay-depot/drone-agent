import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATCH_UP_INTERVAL_MS,
  DEFAULT_SURFACE_MODE,
  SURFACE_MODES,
  isSurfaceMode,
} from '../src/surfaces/mode.js';

describe('isSurfaceMode', () => {
  it('accepts each member of SURFACE_MODES', () => {
    expect(isSurfaceMode('active')).toBe(true);
    expect(isSurfaceMode('passive')).toBe(true);
    expect(isSurfaceMode('observer')).toBe(true);
  });

  it('rejects a differently-cased mode', () => {
    expect(isSurfaceMode('Active')).toBe(false);
    expect(isSurfaceMode('OBSERVER')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isSurfaceMode('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isSurfaceMode(undefined)).toBe(false);
    expect(isSurfaceMode(42)).toBe(false);
    expect(isSurfaceMode(null)).toBe(false);
    expect(isSurfaceMode({})).toBe(false);
  });
});

describe('SURFACE_MODES', () => {
  it('has exactly three members', () => {
    expect(SURFACE_MODES).toHaveLength(3);
    expect([...SURFACE_MODES]).toEqual(['active', 'passive', 'observer']);
  });
});

describe('mode defaults', () => {
  it('defaults to active', () => {
    expect(DEFAULT_SURFACE_MODE).toBe('active');
  });

  it('defaults the catch-up interval to 15 minutes', () => {
    expect(DEFAULT_CATCH_UP_INTERVAL_MS).toBe(900_000);
  });
});

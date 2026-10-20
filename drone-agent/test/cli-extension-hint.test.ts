import { describe, expect, it } from 'vitest';
import { parseCliInvocation } from '../src/index.js';

describe('parseCliInvocation — --extension-hint', () => {
  it('parses --extension-hint <value>', () => {
    const inv = parseCliInvocation([
      '--swarm',
      '--extension-hint',
      'gateway-42',
    ]);
    expect(inv.options.extensionHint).toBe('gateway-42');
  });

  it('defaults extensionHint to undefined', () => {
    const inv = parseCliInvocation([]);
    expect(inv.options.extensionHint).toBeUndefined();
  });

  it('falls back to DRONE_EXTENSION_HINT env', () => {
    const prev = process.env.DRONE_EXTENSION_HINT;
    process.env.DRONE_EXTENSION_HINT = 'env-hint';
    try {
      const inv = parseCliInvocation([]);
      expect(inv.options.extensionHint).toBe('env-hint');
    } finally {
      if (prev === undefined) {
        delete process.env.DRONE_EXTENSION_HINT;
      } else {
        process.env.DRONE_EXTENSION_HINT = prev;
      }
    }
  });

  it('prefers the explicit flag over the env fallback', () => {
    const prev = process.env.DRONE_EXTENSION_HINT;
    process.env.DRONE_EXTENSION_HINT = 'env-hint';
    try {
      const inv = parseCliInvocation(['--extension-hint', 'flag-hint']);
      expect(inv.options.extensionHint).toBe('flag-hint');
    } finally {
      if (prev === undefined) {
        delete process.env.DRONE_EXTENSION_HINT;
      } else {
        process.env.DRONE_EXTENSION_HINT = prev;
      }
    }
  });
});

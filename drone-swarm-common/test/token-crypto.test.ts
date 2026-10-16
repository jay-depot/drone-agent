import { describe, expect, it } from 'vitest';
import {
  generateToken,
  hashToken,
  timingSafeEqualStrings,
  verifyToken,
} from '../src/token-crypto.js';

describe('generateToken', () => {
  it('adds the prefix and 32 bytes of hex by default', () => {
    const token = generateToken('mcpsw_');
    expect(token.startsWith('mcpsw_')).toBe(true);
    expect(token.slice('mcpsw_'.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honors a custom byte length', () => {
    const token = generateToken('t_', 8);
    expect(token.slice(2)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces a different value on each call', () => {
    expect(generateToken('mcpsw_')).not.toBe(generateToken('mcpsw_'));
  });
});

describe('hashToken', () => {
  it('is stable for one plaintext', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('gives different hashes for different plaintexts', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('returns sha256 hex', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyToken', () => {
  it('accepts a matching plaintext', () => {
    const hash = hashToken('mcpsw_secret');
    expect(verifyToken('mcpsw_secret', hash)).toBe(true);
  });

  it('rejects a mismatch', () => {
    const hash = hashToken('mcpsw_secret');
    expect(verifyToken('mcpsw_other', hash)).toBe(false);
  });
});

describe('timingSafeEqualStrings', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqualStrings('hello', 'hello')).toBe(true);
  });

  it('returns false for unequal strings of the same length', () => {
    expect(timingSafeEqualStrings('hello', 'hellp')).toBe(false);
  });

  it('returns false for different-length strings', () => {
    expect(timingSafeEqualStrings('hello', 'hello!')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(timingSafeEqualStrings('', '')).toBe(true);
  });
});

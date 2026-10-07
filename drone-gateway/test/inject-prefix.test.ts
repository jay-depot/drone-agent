import { describe, expect, it } from 'vitest';
import { unescapePrefix, applyPrefix } from '../src/inject/prefix.js';

describe('unescapePrefix', () => {
  it('interprets \\n as a newline', () => {
    expect(unescapePrefix('a\\nb')).toBe('a\nb');
  });

  it('interprets \\t as a tab', () => {
    expect(unescapePrefix('a\\tb')).toBe('a\tb');
  });

  it('interprets \\\\ as a literal backslash', () => {
    expect(unescapePrefix('a\\\\b')).toBe('a\\b');
  });

  it('leaves unknown escapes literal', () => {
    expect(unescapePrefix('a\\qb')).toBe('a\\qb');
  });

  it('leaves plain text untouched', () => {
    expect(unescapePrefix('plain')).toBe('plain');
  });
});

describe('applyPrefix', () => {
  it('prepends the prefix with no separator', () => {
    expect(applyPrefix('⏰ ', 'hello')).toBe('⏰ hello');
  });

  it('returns the text unchanged for an empty prefix', () => {
    expect(applyPrefix('', 'hello')).toBe('hello');
  });

  it('returns the text unchanged for an undefined prefix', () => {
    expect(applyPrefix(undefined, 'hello')).toBe('hello');
  });

  it('prepends only to the first line (the prefix carries its own newline)', () => {
    expect(applyPrefix('X\n', 'one\ntwo')).toBe('X\none\ntwo');
  });
});

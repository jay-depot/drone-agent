import { describe, expect, it } from 'vitest';
import { sanitizeToolSegment } from '../src/shared/tool-name.js';

describe('sanitizeToolSegment', () => {
  it('replaces a dot with an underscore (Kimi-safe tool name)', () => {
    const used = new Set<string>();
    expect(sanitizeToolSegment('card.move', used)).toBe('card_move');
  });

  it('leaves an already-safe name unchanged', () => {
    const used = new Set<string>();
    expect(sanitizeToolSegment('echo', used)).toBe('echo');
    expect(sanitizeToolSegment('schedule_wakeup', used)).toBe(
      'schedule_wakeup'
    );
    expect(sanitizeToolSegment('a-b_c9', used)).toBe('a-b_c9');
  });

  it('replaces every unsafe character, not just dots', () => {
    const used = new Set<string>();
    expect(sanitizeToolSegment('a.b c/d', used)).toBe('a_b_c_d');
  });

  it('returns distinct names on collision instead of overwriting', () => {
    const used = new Set<string>();
    expect(sanitizeToolSegment('foo.bar', used)).toBe('foo_bar');
    expect(sanitizeToolSegment('foo bar', used)).toBe('foo_bar_1');
    expect(sanitizeToolSegment('foo/bar', used)).toBe('foo_bar_2');
  });

  it('frees a name once it is removed from the used set', () => {
    const used = new Set<string>();
    expect(sanitizeToolSegment('foo.bar', used)).toBe('foo_bar');
    used.delete('foo_bar');
    expect(sanitizeToolSegment('foo.bar', used)).toBe('foo_bar');
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CHUNK_CHARS,
  DEFAULT_MAX_TOTAL_CHARS,
  splitMessage,
} from '../src/split-message.js';

function run(text: string, maxChunkChars: number, maxTotalChars = 1_000_000) {
  return splitMessage(text, { maxChunkChars, maxTotalChars });
}

/** A 1-char continuation marker, so small budgets leave room for content. */
const plus = () => '+';

describe('splitMessage', () => {
  describe('no split needed', () => {
    it('returns the text unchanged when it fits', () => {
      expect(run('abc', 10)).toEqual(['abc']);
    });

    it('returns the text unchanged when it is exactly at the budget', () => {
      expect(run('abcdefghij', 10)).toEqual(['abcdefghij']);
    });

    it('returns one chunk for an empty string', () => {
      expect(run('', 10)).toEqual(['']);
    });

    it('sends a short text whole even when the total ceiling is tiny', () => {
      expect(run('abc', 10, 3)).toEqual(['abc']);
    });
  });

  describe('split point preference', () => {
    it('prefers the last paragraph break before the budget', () => {
      expect(run('para one\n\npara two\n\npara three', 20)).toEqual([
        'para one\n\npara two\n',
        'para three (2/2)',
      ]);
    });

    it('falls back to the last line break when no paragraph break fits', () => {
      expect(run('line one\nline two\nline three', 20)).toEqual([
        'line one\nline two',
        'line three (2/2)',
      ]);
    });

    it('hard cuts when no break fits', () => {
      const chunks = splitMessage('abcdefghij', {
        maxChunkChars: 4,
        maxTotalChars: 1_000_000,
        continuationMarker: plus,
      });
      expect(chunks).toEqual(['abcd', 'efg+', 'hij+']);
    });

    it('drops exactly one break character at a paragraph split (keeps one \\n)', () => {
      const chunks = splitMessage('aaaaa\n\nbb', {
        maxChunkChars: 6,
        maxTotalChars: 1_000_000,
        continuationMarker: plus,
      });
      expect(chunks).toEqual(['aaaaa\n', 'bb+']);
    });

    it('drops the line break character at a line split', () => {
      const chunks = splitMessage('aaaaa\nbb', {
        maxChunkChars: 6,
        maxTotalChars: 1_000_000,
        continuationMarker: plus,
      });
      expect(chunks).toEqual(['aaaaa', 'bb+']);
    });

    it('skips a chunk that holds only line breaks', () => {
      const chunks = splitMessage('xx\n\n\nyy', {
        maxChunkChars: 3,
        maxTotalChars: 1_000_000,
        continuationMarker: plus,
      });
      expect(chunks).toEqual(['xx\n', 'yy+']);
    });

    it('splits mixed break styles at the best available point', () => {
      const chunks = splitMessage('a\nb\ncd\nef', {
        maxChunkChars: 3,
        maxTotalChars: 1_000_000,
        continuationMarker: plus,
      });
      expect(chunks).toEqual(['a\nb', 'cd+', 'ef+']);
    });

    it('hard cuts one character at a time when the budget is minimal', () => {
      const chunks = splitMessage('aa\n\n\nbbbbbbbbbbbb', {
        maxChunkChars: 3,
        maxTotalChars: 1_000_000,
        continuationMarker: plus,
      });
      expect(chunks).toEqual([
        'aa\n',
        'bb+',
        'bb+',
        'bb+',
        'bb+',
        'bb+',
        'bb+',
      ]);
    });
  });

  describe('continuation markers', () => {
    it('leaves the first message unmarked and suffixes the rest', () => {
      expect(run('a\n\nb\n\nc', 2)).toEqual(['a\n', 'b (2/3)', 'c (3/3)']);
    });

    it('reserves marker width from the continuation budget', () => {
      const chunks = run('x'.repeat(60), 20);
      // With the default 6-char marker, 20-char budgets shrink to 14-char
      // continuations once the marker count is known (fixed point at 4).
      expect(chunks).toEqual([
        'x'.repeat(20),
        'x'.repeat(14) + ' (2/4)',
        'x'.repeat(14) + ' (3/4)',
        'x'.repeat(12) + ' (4/4)',
      ]);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(20);
    });

    it('shrinks the chunk count to the smallest self-consistent plan', () => {
      const chunks = run('x'.repeat(100), 30);
      expect(chunks).toEqual([
        'x'.repeat(30),
        'x'.repeat(24) + ' (2/4)',
        'x'.repeat(24) + ' (3/4)',
        'x'.repeat(22) + ' (4/4)',
      ]);
    });

    it('supports custom continuation markers', () => {
      const chunks = splitMessage('abcdefghij', {
        maxChunkChars: 4,
        maxTotalChars: 1_000_000,
        continuationMarker: () => '…',
      });
      expect(chunks).toEqual(['abcd', 'efg…', 'hij…']);
    });
  });

  describe('total ceiling', () => {
    it('sends the full plan when it fits the ceiling exactly', () => {
      const chunks = run('x'.repeat(600), 200, 618);
      expect(chunks).toEqual([
        'x'.repeat(200),
        'x'.repeat(194) + ' (2/4)',
        'x'.repeat(194) + ' (3/4)',
        'x'.repeat(12) + ' (4/4)',
      ]);
      expect(chunks.join('')).toHaveLength(618);
    });

    it('truncates the tail with a dropped-count marker when the ceiling binds', () => {
      const chunks = run('x'.repeat(200), 90, 210);
      expect(chunks).toEqual([
        'x'.repeat(90),
        'x'.repeat(42) + '[message truncated — 68 characters were dropped]',
      ]);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(90);
    });

    it('bounds the truncated tail by the chunk budget, not just the ceiling', () => {
      const chunks = run('x'.repeat(300), 100, 290);
      expect(chunks).toEqual([
        'x'.repeat(100),
        'x'.repeat(94) + ' (2/3)',
        'x'.repeat(42) + '[message truncated — 64 characters were dropped]',
      ]);
      expect(chunks.join('')).toHaveLength(290);
    });

    it('emits the truncation marker alone when nothing else fits', () => {
      expect(run('x'.repeat(200), 50, 20)).toEqual([
        '[message truncated — 200 characters were dropped]',
      ]);
    });

    it('keeps the marker even when it alone exceeds the ceiling', () => {
      expect(run('x'.repeat(100), 50, 30)).toEqual([
        '[message truncated — 100 characters were dropped]',
      ]);
    });

    it('clamps a ceiling below the chunk budget to one truncated message', () => {
      const chunks = splitMessage('x'.repeat(25_000), {
        maxChunkChars: 20_000,
        maxTotalChars: 10_000,
      });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(10_000);
      expect(chunks[0]).toContain('message truncated');
      expect(chunks[0]).toContain('15051 characters were dropped');
      expect(chunks[0].endsWith(']')).toBe(true);
    });

    it('truncates with a short custom marker at an exact ceiling', () => {
      const chunks = splitMessage('x'.repeat(200), {
        maxChunkChars: 50,
        maxTotalChars: 20,
        truncationMarker: () => 'T',
      });
      expect(chunks).toEqual(['x'.repeat(19) + 'T']);
    });

    it('supports custom truncation markers', () => {
      const chunks = splitMessage('abcdefghij', {
        maxChunkChars: 4,
        maxTotalChars: 12,
        truncationMarker: dropped => `T${dropped}`,
      });
      expect(chunks).toEqual(['abcd', 'efT4']);
    });
  });

  describe('guards and constants', () => {
    it('rejects a zero chunk budget', () => {
      expect(() =>
        splitMessage('x', { maxChunkChars: 0, maxTotalChars: 10 })
      ).toThrow(RangeError);
    });

    it('rejects a zero total ceiling', () => {
      expect(() =>
        splitMessage('x', { maxChunkChars: 10, maxTotalChars: 0 })
      ).toThrow(RangeError);
    });

    it('exports the documented defaults', () => {
      expect(DEFAULT_MAX_CHUNK_CHARS).toBe(20_000);
      expect(DEFAULT_MAX_TOTAL_CHARS).toBe(100_000);
    });
  });

  describe('properties on a realistic document', () => {
    it('keeps every message within the chunk budget and marks continuations', () => {
      const text = Array.from({ length: 250 }, (_, i) => `line ${i}`).join(
        '\n\n'
      );
      const chunks = run(text, 500);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].length).toBeLessThanOrEqual(500);
      expect(chunks[0].endsWith(' (1/')).toBe(false);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].length).toBeLessThanOrEqual(500);
        expect(chunks[i]).toMatch(/ \(\d+\/\d+\)$/);
      }
      const last = chunks[chunks.length - 1].match(/ \((\d+)\/(\d+)\)$/);
      expect(last).not.toBeNull();
      expect(Number(last?.[1])).toBe(chunks.length);
      expect(Number(last?.[2])).toBe(chunks.length);
    });
  });
});

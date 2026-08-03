/**
 * Tests for the visual text model.
 *
 * Covers:
 *   - Empty string
 *   - Single line shorter than width
 *   - Single line that wraps
 *   - Multiple logical lines
 *   - Word longer than width (character-wrap fallback)
 *   - offsetToVisual round-trip
 *   - visualToOffset round-trip
 *   - Word boundary detection
 *   - Line start/end detection
 */

import { describe, expect, it } from 'vitest';
import {
  computeVisualLines,
  offsetToVisual,
  visualToOffset,
  findLineStart,
  findLineEnd,
  findWordStart,
  findWordEnd,
} from '../src/tui/shared/visual-text-model.js';

describe('computeVisualLines', () => {
  it('returns empty array for empty string', () => {
    expect(computeVisualLines('', 10)).toEqual([]);
  });

  it('returns a single line for text shorter than width', () => {
    const lines = computeVisualLines('hello', 10);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      startOffset: 0,
      endOffset: 5,
      isContinuation: false,
    });
  });

  it('wraps a single long line', () => {
    // "hello world foo bar" at width 10
    // "hello" (0-5) fits, " world" (5-11) would make 11 > 10, so wrap
    // Line 0: "hello" (0-5)
    // Line 1: "world" (6-11) fits, " foo" (11-15) would make 9 > 10... wait
    // Actually: line 1 starts at 6, "world" (6-11), then " foo" (11-15) = 9 chars > 10? No, 15-6=9 <= 10
    // So line 1: "world foo" (6-15) — wait, " foo" is 4 chars, 11+4=15, 15-6=9 <= 10
    // Then " bar" (15-19) = 4 chars, 19-6=13 > 10, so wrap
    // Line 2: "bar" (16-19)
    const lines = computeVisualLines('hello world foo bar', 10);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0].startOffset).toBe(0);
    expect(lines[0].isContinuation).toBe(false);
    expect(lines[1].isContinuation).toBe(true);
  });

  it('handles multiple logical lines', () => {
    const lines = computeVisualLines('hello\nworld', 20);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      startOffset: 0,
      endOffset: 5,
      isContinuation: false,
    });
    expect(lines[1]).toEqual({
      startOffset: 6,
      endOffset: 11,
      isContinuation: false,
    });
  });

  it('character-wraps a word longer than width', () => {
    const lines = computeVisualLines('superlongword', 5);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0].startOffset).toBe(0);
    expect(lines[0].endOffset).toBe(5);
    expect(lines[0].isContinuation).toBe(false);
    expect(lines[1].startOffset).toBe(5);
    expect(lines[1].endOffset).toBe(10);
    expect(lines[1].isContinuation).toBe(true);
    expect(lines[2].startOffset).toBe(10);
    expect(lines[2].endOffset).toBe(13);
    expect(lines[2].isContinuation).toBe(true);
  });

  it('handles width of 1', () => {
    const lines = computeVisualLines('ab', 1);
    expect(lines).toHaveLength(2);
    expect(lines[0].startOffset).toBe(0);
    expect(lines[0].endOffset).toBe(1);
    expect(lines[1].startOffset).toBe(1);
    expect(lines[1].endOffset).toBe(2);
  });

  it('handles trailing newline', () => {
    const lines = computeVisualLines('hello\n', 10);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      startOffset: 0,
      endOffset: 5,
      isContinuation: false,
    });
    expect(lines[1]).toEqual({
      startOffset: 6,
      endOffset: 6,
      isContinuation: false,
    });
  });

  it('handles consecutive newlines', () => {
    const lines = computeVisualLines('a\n\nb', 10);
    expect(lines).toHaveLength(3);
    expect(lines[0].startOffset).toBe(0);
    expect(lines[0].endOffset).toBe(1);
    expect(lines[1].startOffset).toBe(2);
    expect(lines[1].endOffset).toBe(2);
    expect(lines[2].startOffset).toBe(3);
    expect(lines[2].endOffset).toBe(4);
  });
});

describe('offsetToVisual', () => {
  it('returns (0,0) for empty text', () => {
    expect(offsetToVisual('', 0, 10)).toEqual({ line: 0, col: 0 });
  });

  it('returns correct position for short text', () => {
    expect(offsetToVisual('hello', 2, 10)).toEqual({ line: 0, col: 2 });
  });

  it('returns correct position for wrapped text', () => {
    // "hello world" at width 5:
    // "hello" (0-5) fits on line 0
    // "world" (6-11) — would make line 0 be 11 chars > 5, so wrap
    // Line 0: [0-5], Line 1: [6-11]
    // Offset 7 is on line 1, col 1 (7 - 6 = 1)
    const pos = offsetToVisual('hello world', 7, 5);
    expect(pos.line).toBe(1);
    expect(pos.col).toBe(1);
  });

  it('clamps offset past end to last position', () => {
    const pos = offsetToVisual('hi', 10, 5);
    expect(pos.line).toBe(0);
    expect(pos.col).toBe(2);
  });
});

describe('visualToOffset', () => {
  it('returns 0 for empty text', () => {
    expect(visualToOffset('', 0, 0, 10)).toBe(0);
  });

  it('returns correct offset for short text', () => {
    expect(visualToOffset('hello', 0, 2, 10)).toBe(2);
  });

  it('clamps col to line length', () => {
    expect(visualToOffset('hi', 0, 10, 10)).toBe(2);
  });

  it('clamps line to valid range', () => {
    // "hi" at width 10: one visual line [0-2]
    // line 5 is clamped to 0 (lines.length - 1 = 0)
    expect(visualToOffset('hi', 5, 0, 10)).toBe(0);
  });

  it('round-trips with offsetToVisual', () => {
    const text = 'hello world foo bar baz';
    for (let offset = 0; offset <= text.length; offset++) {
      const visual = offsetToVisual(text, offset, 8);
      const roundTrip = visualToOffset(text, visual.line, visual.col, 8);
      expect(roundTrip).toBe(offset);
    }
  });
});

describe('findLineStart', () => {
  it('returns 0 for offset in first line', () => {
    expect(findLineStart('hello\nworld', 3)).toBe(0);
  });

  it('returns offset after previous newline', () => {
    expect(findLineStart('hello\nworld', 8)).toBe(6);
  });

  it('returns 0 for offset 0', () => {
    expect(findLineStart('hello', 0)).toBe(0);
  });

  it('handles offset at newline', () => {
    expect(findLineStart('hello\nworld', 5)).toBe(0);
  });
});

describe('findLineEnd', () => {
  it('returns offset of next newline', () => {
    expect(findLineEnd('hello\nworld', 3)).toBe(5);
  });

  it('returns text.length for last line', () => {
    expect(findLineEnd('hello\nworld', 8)).toBe(11);
  });

  it('returns text.length for single line', () => {
    expect(findLineEnd('hello', 3)).toBe(5);
  });

  it('handles offset at newline', () => {
    expect(findLineEnd('hello\nworld', 5)).toBe(5);
  });
});

describe('findWordStart', () => {
  it('returns 0 for offset 0', () => {
    expect(findWordStart('hello world', 0)).toBe(0);
  });

  it('returns start of current word', () => {
    expect(findWordStart('hello world', 7)).toBe(6);
  });

  it('returns offset if already at word start', () => {
    expect(findWordStart('hello world', 6)).toBe(6);
  });

  it('skips back over whitespace to previous word', () => {
    expect(findWordStart('hello   world', 10)).toBe(8);
  });

  it('returns 0 when at start of first word', () => {
    expect(findWordStart('hello', 3)).toBe(0);
  });
});

describe('findWordEnd', () => {
  it('returns text.length for offset at end', () => {
    expect(findWordEnd('hello', 5)).toBe(5);
  });

  it('returns end of current word', () => {
    expect(findWordEnd('hello world', 3)).toBe(5);
  });

  it('skips whitespace to next word end', () => {
    // "hello   world" — offset 7 is at the third space
    // Skip whitespace: 7→8 (hits 'w')
    // Skip word: 8→13 (past 'd', past end of string)
    expect(findWordEnd('hello   world', 7)).toBe(13);
  });

  it('returns text.length for last word', () => {
    expect(findWordEnd('hello world', 6)).toBe(11);
  });
});

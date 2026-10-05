import { describe, expect, it } from 'vitest';
import {
  formatJson,
  formatList,
  truncationTail,
} from '../src/console/format.js';

describe('formatJson', () => {
  it('renders a fenced json block', () => {
    expect(formatJson({ a: 1 })).toBe('```json\n{\n  "a": 1\n}\n```');
  });

  it('renders arrays', () => {
    expect(formatJson([1, 2])).toBe('```json\n[\n  1,\n  2\n]\n```');
  });
});

describe('truncationTail', () => {
  it('is empty when nothing was truncated', () => {
    expect(truncationTail(5, 5)).toBe('');
    expect(truncationTail(6, 5)).toBe('');
  });

  it('reports the remaining count and the paging flags', () => {
    expect(truncationTail(3, 10)).toBe('… 7 more (use --limit/--offset)');
  });
});

describe('formatList', () => {
  it('joins lines without a tail when complete', () => {
    expect(formatList(['a', 'b'], 2)).toBe('a\nb');
  });

  it('appends the tail when the page is short', () => {
    expect(formatList(['a'], 3)).toBe('a\n… 2 more (use --limit/--offset)');
  });

  it('renders (none) for an empty list', () => {
    expect(formatList([], 0)).toBe('(none)');
  });
});

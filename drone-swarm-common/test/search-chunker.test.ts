import { describe, expect, it } from 'vitest';
import { chunkText, chunkMarkdown, chunkLines } from '../src/search-chunker.js';

describe('chunkText', () => {
  it('keeps short text as a single chunk', () => {
    expect(chunkText('hello world', 100)).toEqual(['hello world']);
  });

  it('splits on paragraph boundaries', () => {
    const text = 'para one\n\npara two\n\npara three';
    const chunks = chunkText(text, 5);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('para one');
    expect(chunks.join(' ')).toContain('para three');
  });

  it('splits a single oversized paragraph by sentences', () => {
    const text =
      'First sentence here. Second sentence here. Third sentence here.';
    const chunks = chunkText(text, 6);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.length <= 6 * 4)).toBe(true);
  });
});

describe('chunkMarkdown', () => {
  it('groups a heading with its following paragraphs', () => {
    const md = '# Title\n\nSome intro text.\n\n## Section\n\nBody text here.\n';
    const chunks = chunkMarkdown(md, 1000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain('# Title');
    expect(chunks[0]).toContain('Some intro text.');
    expect(chunks[1]).toContain('## Section');
    expect(chunks[1]).toContain('Body text here.');
  });

  it('splits an oversized section at paragraph boundaries', () => {
    const md =
      '# Big\n\n' + 'Sentence one here. '.repeat(40) + '\n\n' + 'tail\n';
    const chunks = chunkMarkdown(md, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.length <= 20 * 4)).toBe(true);
  });

  it('handles text with no headings as a single chunk', () => {
    const md = 'just some prose\n\nwith a paragraph';
    const chunks = chunkMarkdown(md, 1000);
    expect(chunks.length).toBe(1);
  });
});

describe('chunkLines', () => {
  it('splits into line windows with overlap', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const chunks = chunkLines(text, 1000, 4, 1);
    expect(chunks.length).toBeGreaterThan(1);
    // Overlap means consecutive chunks share lines.
    expect(chunks[0]).toContain('line0');
    expect(chunks[1]).toContain('line3');
  });

  it('respects maxTokens for oversized chunks', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const chunks = chunkLines(text, 5);
    expect(chunks.every(c => c.length <= 5 * 4)).toBe(true);
  });
});

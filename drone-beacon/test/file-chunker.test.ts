import { describe, expect, it, beforeAll } from 'vitest';
import { chunkFile } from '../src/file-chunker.js';

beforeAll(async () => {
  await chunkFile('warmup.ts', 'export const x = 1;\n', 480);
});

describe('chunkFile', () => {
  it('routes .ts to the AST chunker', async () => {
    const src = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
    const chunks = await chunkFile('test.ts', src, 480);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('export function add');
  });

  it('routes .md to the markdown chunker', async () => {
    const md = '# Title\n\nBody text here.\n';
    const chunks = await chunkFile('README.md', md, 480);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('# Title');
  });

  it('routes .json to the line chunker', async () => {
    const json = Array.from({ length: 30 }, (_, i) => `"key${i}": ${i}`).join(
      ',\n'
    );
    const chunks = await chunkFile('data.json', json, 480);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('routes .hbs to whole-file chunking', async () => {
    const tpl = '{{#if x}}\nhello\n{{/if}}\n';
    const chunks = await chunkFile('template.hbs', tpl, 480);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('{{#if x}}');
  });

  it('falls back to paragraph chunking for unknown text extensions', async () => {
    const text = 'para one\n\npara two\n';
    const chunks = await chunkFile('notes.txt', text, 480);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join(' ')).toContain('para one');
  });
});

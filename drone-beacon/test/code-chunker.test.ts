import { describe, expect, it, beforeAll } from 'vitest';
import { chunkCode } from '../src/code-chunker.js';

// Warm the parser/language caches once so tests don't each pay the wasm load.
beforeAll(async () => {
  await chunkCode('warmup.ts', 'export const x = 1;\n', 480);
});

/** Assert a chunk result is non-null and return it. */
async function chunkOrThrow(
  file: string,
  src: string,
  maxTokens: number
): Promise<string[]> {
  const chunks = await chunkCode(file, src, maxTokens);
  if (chunks === null) {
    throw new Error(`chunkCode returned null for ${file}`);
  }
  return chunks;
}

describe('chunkCode', () => {
  it('returns null for an unknown extension', async () => {
    expect(await chunkCode('file.xyz', 'hello', 480)).toBeNull();
  });

  it('keeps a small file as a single chunk', async () => {
    const src = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
    const chunks = await chunkOrThrow('test.ts', src, 480);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('export function add');
  });

  it('splits at function boundaries', async () => {
    // Two functions large enough to exceed the merge floor (0.5 × 480 × 4
    // chars) so they stay as separate chunks.
    const body = Array.from(
      { length: 60 },
      (_, i) => `  const v${i} = a + ${i};`
    ).join('\n');
    const src = [
      `export function add(a: number, b: number): number {`,
      body,
      '  return a + b;',
      '}',
      '',
      `export function sub(a: number, b: number): number {`,
      body,
      '  return a - b;',
      '}',
      '',
    ].join('\n');
    const chunks = await chunkOrThrow('test.ts', src, 480);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n')).toContain('export function add');
    expect(chunks.join('\n')).toContain('export function sub');
  });

  it('attaches a leading docstring to its function', async () => {
    const src = [
      '/**',
      ' * Adds two numbers.',
      ' */',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
    ].join('\n');
    const chunks = await chunkOrThrow('test.ts', src, 480);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Adds two numbers.');
    expect(chunks[0]).toContain('export function add');
  });

  it('splits an oversized function at statement boundaries, keeping the signature', async () => {
    const lines = ['export function huge(a: number): number {'];
    for (let i = 0; i < 400; i++) lines.push(`  const v${i} = a + ${i};`);
    lines.push('  return a;', '}');
    const src = lines.join('\n');
    const chunks = await chunkOrThrow('test.ts', src, 480);
    expect(chunks.length).toBeGreaterThan(1);
    // The signature stays attached to the first body chunk.
    expect(chunks[0]).toContain('function huge(a: number): number');
    // No chunk exceeds the 2× split ceiling (480 * 4 * 2 chars).
    const maxChars = 480 * 4 * 2;
    expect(chunks.every(c => c.length <= maxChars)).toBe(true);
  });

  it('handles a syntax error gracefully without dropping the file', async () => {
    const src = `function broken( {\n  return ;\n}\n`;
    const chunks = await chunkOrThrow('test.ts', src, 480);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('\n')).toContain('function broken');
  });

  it('supports multiple languages', async () => {
    const cases: Array<[string, string, string]> = [
      ['test.py', 'def add(a, b):\n    return a + b\n', 'def add'],
      ['test.rs', 'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n', 'fn add'],
      [
        'test.go',
        'package main\n\nfunc add(a, b int) int {\n    return a + b\n}\n',
        'func add',
      ],
      ['test.c', 'int add(int a, int b) {\n    return a + b;\n}\n', 'int add'],
      [
        'test.java',
        'class Foo {\n    int add(int a, int b) { return a + b; }\n}\n',
        'class Foo',
      ],
    ];
    for (const [file, src, expected] of cases) {
      const chunks = await chunkOrThrow(file, src, 480);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join('\n')).toContain(expected);
    }
  });
});

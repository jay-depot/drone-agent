import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createReferenceCapability,
  tokenizeText,
  resolveReferencePath,
} from '../src/runtime/reference-expansion/index.js';

describe('tokenizeText', () => {
  it('recognizes a reference at start-of-text', () => {
    const tokens = tokenizeText('@src/foo.ts');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      type: 'reference',
      kind: null,
      value: 'src/foo.ts',
    });
  });

  it('recognizes a reference after whitespace', () => {
    const tokens = tokenizeText('see @src/foo.ts please');
    expect(tokens.map(t => t.type)).toEqual(['text', 'reference', 'text']);
    expect(tokens[1]).toMatchObject({ type: 'reference', value: 'src/foo.ts' });
  });

  it('does not treat mid-word @ as a reference', () => {
    const tokens = tokenizeText('user@host.com');
    expect(tokens).toEqual([{ type: 'text', text: 'user@host.com' }]);
  });

  it('parses a kind prefix into kind + value', () => {
    const tokens = tokenizeText('@skill:code-review');
    expect(tokens[0]).toMatchObject({
      type: 'reference',
      kind: 'skill',
      value: 'code-review',
    });
  });

  it('parses a valid-kind-shaped prefix even when the kind is unknown', () => {
    const tokens = tokenizeText('@a:b.ts');
    expect(tokens[0]).toMatchObject({
      type: 'reference',
      kind: 'a',
      value: 'b.ts',
      body: 'a:b.ts',
    });
  });

  it('does not treat an invalid prefix as a kind', () => {
    const tokens = tokenizeText('@A:b');
    expect(tokens[0]).toMatchObject({
      type: 'reference',
      kind: null,
      value: 'A:b',
    });
  });

  it('supports the braced form with spaces', () => {
    const tokens = tokenizeText('@{my file.md}');
    expect(tokens[0]).toMatchObject({
      type: 'reference',
      value: 'my file.md',
    });
  });

  it('treats an empty reference as text', () => {
    expect(tokenizeText('@')).toEqual([{ type: 'text', text: '@' }]);
    expect(tokenizeText('@{}')).toEqual([{ type: 'text', text: '@{}' }]);
  });

  it('unescapes \\@ to a literal @', () => {
    const tokens = tokenizeText('email \\@home');
    expect(tokens).toEqual([{ type: 'text', text: 'email @home' }]);
  });
});

describe('resolveReferencePath', () => {
  const ctx = { cwd: '/work/project', homedir: '/home/user' };

  it('resolves a bare path against the CWD', () => {
    expect(resolveReferencePath('src/foo.ts', ctx)).toBe(
      '/work/project/src/foo.ts'
    );
  });

  it('expands a leading ~/', () => {
    expect(resolveReferencePath('~/notes.md', ctx)).toBe('/home/user/notes.md');
  });

  it('expands a bare ~', () => {
    expect(resolveReferencePath('~', ctx)).toBe('/home/user');
  });

  it('resolves an absolute path as-is', () => {
    expect(resolveReferencePath('/etc/hosts', ctx)).toBe('/etc/hosts');
  });
});

describe('createReferenceCapability', () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'refexp-'));
    home = await mkdtemp(path.join(tmpdir(), 'refhome-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const makeCap = () => createReferenceCapability({ cwd: dir, homedir: home });

  it('fast-paths text without @', async () => {
    const cap = makeCap();
    const result = await cap.expandUserMessage('hello world');
    expect(result).toEqual({ text: 'hello world', images: [], notices: [] });
  });

  it('inlines a file with a fenced block and a header', async () => {
    await writeFile(path.join(dir, 'foo.ts'), 'const x = 1;\n');
    const cap = makeCap();
    const result = await cap.expandUserMessage('look at @foo.ts');
    expect(result.text).toContain('look at @foo.ts');
    expect(result.text).toContain('--- Referenced content ---');
    expect(result.text).toContain('### @foo.ts');
    expect(result.text).toContain('```ts');
    expect(result.text).toContain('const x = 1;');
    expect(result.notices).toEqual(['[expanded @foo.ts (1 lines, 13 B)]']);
  });

  it('leaves an unresolved non-pathlike token silent', async () => {
    const cap = makeCap();
    const result = await cap.expandUserMessage('hi @handles');
    expect(result.text).toBe('hi @handles');
    expect(result.notices).toEqual([]);
  });

  it('notices an unresolved pathlike token', async () => {
    const cap = makeCap();
    const result = await cap.expandUserMessage('see @src/nope.ts');
    expect(result.notices).toEqual(['[unresolved reference: @src/nope.ts]']);
  });

  it('dedupes identical references', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'aaa');
    const cap = makeCap();
    const result = await cap.expandUserMessage('@a.txt and @a.txt');
    expect(result.text.match(/### @a\.txt/g)).toHaveLength(1);
  });

  it('lists a directory recursively (names only)', async () => {
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'a.txt'), 'a');
    await writeFile(path.join(dir, 'sub', 'b.txt'), 'b');
    const cap = makeCap();
    const result = await cap.expandUserMessage('@./');
    expect(result.text).toContain('a.txt');
    expect(result.text).toContain('sub/');
    expect(result.text).toContain('sub/b.txt');
    expect(result.text).not.toContain('aaa');
  });

  it('skips binary files with a notice', async () => {
    await writeFile(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
    const cap = makeCap();
    const result = await cap.expandUserMessage('@bin.dat');
    expect(result.notices).toEqual(['[skipped binary: @bin.dat]']);
    expect(result.text).not.toContain('--- Referenced content ---');
  });

  it('expands globs and caps matches', async () => {
    for (let i = 0; i < 40; i++) {
      await writeFile(
        path.join(dir, `f${String(i).padStart(2, '0')}.txt`),
        'x'
      );
    }
    const cap = makeCap();
    const result = await cap.expandUserMessage('@*.txt');
    expect(result.text).toContain('matched 40, showing 30');
  });

  it('emits one aggregate receipt for a glob (count + total size)', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'aaaa');
    await writeFile(path.join(dir, 'b.txt'), 'bb');
    const cap = makeCap();
    const result = await cap.expandUserMessage('@*.txt');
    expect(result.notices).toEqual(['[expanded @*.txt (2 files, 6 B)]']);
  });

  it('uses the singular form for a one-file glob and notes skips', async () => {
    await writeFile(path.join(dir, 'only.txt'), 'ok');
    await writeFile(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2]));
    const cap = makeCap();
    const result = await cap.expandUserMessage('@*.{txt,dat}');
    expect(result.notices).toEqual([
      '[expanded @*.{txt,dat} (1 file, 2 B, 1 skipped)]',
    ]);
  });

  it('truncates a file beyond MAX_LINES', async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `line ${i}`);
    await writeFile(path.join(dir, 'big.txt'), lines.join('\n'));
    const cap = makeCap();
    const result = await cap.expandUserMessage('@big.txt');
    expect(result.text).toContain('[… truncated]');
    expect(result.text).toContain('line 1999');
    expect(result.text).not.toContain('line 2050');
  });

  it('notices a reserved kind when its plugin is not enabled', async () => {
    const cap = makeCap();
    const result = await cap.expandUserMessage('@skill:code-review');
    expect(result.notices).toEqual([
      '[skill references unavailable: skill plugin not enabled]',
    ]);
    expect(result.text).toBe('@skill:code-review');
  });

  it('treats an unknown kind prefix as a file path', async () => {
    await writeFile(path.join(dir, 'a:b.ts'), 'content');
    const cap = makeCap();
    const result = await cap.expandUserMessage('@a:b.ts');
    expect(result.text).toContain('content');
    expect(result.notices).toEqual(['[expanded @a:b.ts (1 lines, 7 B)]']);
  });

  it('registers and uses a custom kind resolver', async () => {
    const cap = makeCap();
    cap.registerKind('skill', async value => ({
      block: `body of ${value}`,
      images: [],
      dedupKey: `skill:${value}`,
    }));
    const result = await cap.expandUserMessage('@skill:code-review');
    expect(result.text).toContain('### @skill:code-review');
    expect(result.text).toContain('body of code-review');
    expect(result.notices).toEqual([]);
  });

  it('rejects an invalid kind name', () => {
    const cap = makeCap();
    expect(() =>
      cap.registerKind('Bad Name', async () => ({ block: '', images: [] }))
    ).toThrow();
  });

  it('expands via the home directory', async () => {
    await writeFile(path.join(home, 'notes.md'), 'home note');
    const cap = makeCap();
    const result = await cap.expandUserMessage('@~/notes.md');
    expect(result.text).toContain('home note');
  });
});

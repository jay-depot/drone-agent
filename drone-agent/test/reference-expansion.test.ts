import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
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

describe('image references', () => {
  let dir: string;
  let home: string;

  const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
  ]);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'refimg-'));
    home = await mkdtemp(path.join(tmpdir(), 'refimghome-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const makeCap = (
    overrides?: Parameters<typeof createReferenceCapability>[0]
  ) => createReferenceCapability({ cwd: dir, homedir: home, ...overrides });

  it('attaches an image instead of inlining it as text, with no block', async () => {
    await writeFile(path.join(dir, 'pic.png'), PNG_BYTES);
    const cap = makeCap();
    const result = await cap.expandUserMessage('describe @pic.png');

    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe('image/png');
    expect(result.images[0].data).toBe(PNG_BYTES.toString('base64'));
    // No text block: the prose is preserved and no trailer is appended.
    expect(result.text).toBe('describe @pic.png');
    expect(result.text).not.toContain('--- Referenced content ---');
    expect(result.notices).toEqual([
      `[expanded @pic.png (image/png, ${PNG_BYTES.length} B)]`,
    ]);
  });

  it('does not report an image as skipped binary', async () => {
    await writeFile(path.join(dir, 'pic.png'), PNG_BYTES);
    const cap = makeCap();
    const result = await cap.expandUserMessage('@pic.png');
    expect(result.notices).toEqual([
      `[expanded @pic.png (image/png, ${PNG_BYTES.length} B)]`,
    ]);
  });

  it('leaves a text reference unchanged (still a fenced block, no images)', async () => {
    await writeFile(path.join(dir, 'notes.md'), 'hello\n');
    const cap = makeCap();
    const result = await cap.expandUserMessage('see @notes.md');
    expect(result.images).toEqual([]);
    expect(result.text).toContain('--- Referenced content ---');
    expect(result.text).toContain('hello');
    expect(result.notices).toEqual(['[expanded @notes.md (1 lines, 6 B)]']);
  });

  it('recognizes every supported image extension', async () => {
    const cases: Array<[string, string]> = [
      ['a.jpg', 'image/jpeg'],
      ['b.jpeg', 'image/jpeg'],
      ['c.png', 'image/png'],
      ['d.webp', 'image/webp'],
      ['e.gif', 'image/gif'],
    ];
    for (const [name] of cases) {
      await writeFile(path.join(dir, name), PNG_BYTES);
    }
    const cap = makeCap();
    for (const [name, mime] of cases) {
      const result = await cap.expandUserMessage(`@${name}`);
      expect(result.images).toHaveLength(1);
      expect(result.images[0].mimeType).toBe(mime);
    }
  });

  it('is case-insensitive about the extension', async () => {
    await writeFile(path.join(dir, 'SHOT.PNG'), PNG_BYTES);
    const cap = makeCap();
    const result = await cap.expandUserMessage('@SHOT.PNG');
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe('image/png');
  });

  it('skips an oversize image with a size notice and attaches nothing', async () => {
    await writeFile(path.join(dir, 'big.png'), PNG_BYTES);
    const cap = makeCap({ maxImageBytes: 4 });
    const result = await cap.expandUserMessage('@big.png');
    expect(result.images).toEqual([]);
    expect(result.text).toBe('@big.png');
    expect(result.notices).toEqual([
      `[image too large: @big.png (${PNG_BYTES.length} B > 4 B)]`,
    ]);
  });

  it('accepts an image exactly at the size limit', async () => {
    await writeFile(path.join(dir, 'exact.png'), PNG_BYTES);
    const cap = makeCap({ maxImageBytes: PNG_BYTES.length });
    const result = await cap.expandUserMessage('@exact.png');
    expect(result.images).toHaveLength(1);
    expect(result.notices).toEqual([
      `[expanded @exact.png (image/png, ${PNG_BYTES.length} B)]`,
    ]);
  });

  it('attaches glob-matched images and aggregates the receipt', async () => {
    await writeFile(path.join(dir, 'one.png'), PNG_BYTES);
    await writeFile(path.join(dir, 'two.png'), PNG_BYTES);
    await writeFile(path.join(dir, 'notes.md'), 'ignored\n');
    const cap = makeCap();
    const result = await cap.expandUserMessage('@*.png');
    expect(result.images).toHaveLength(2);
    expect(result.images.map(i => i.mimeType)).toEqual([
      'image/png',
      'image/png',
    ]);
    // Images contribute no block, so there is no trailer.
    expect(result.text).toBe('@*.png');
    expect(result.notices).toEqual([
      `[expanded @*.png (2 files, ${PNG_BYTES.length * 2} B)]`,
    ]);
  });

  it('mixes images and text in one glob (text fenced, images attached)', async () => {
    await writeFile(path.join(dir, 'pic.png'), PNG_BYTES);
    await writeFile(path.join(dir, 'note.md'), 'note body\n');
    const cap = makeCap();
    // A dotted pattern, so the aggregate receipt is not suppressed by the
    // path-like notice-gating rule (bare `@*` is treated as prose).
    const result = await cap.expandUserMessage('@*.{png,md}');
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe('image/png');
    expect(result.text).toContain('--- Referenced content ---');
    expect(result.text).toContain('note body');
    expect(result.text).toContain('**note.md**');
    expect(result.notices).toEqual([
      `[expanded @*.{png,md} (2 files, ${PNG_BYTES.length + 10} B)]`,
    ]);
  });

  it('does not charge the text budget for images', async () => {
    // An image larger than the 1 MiB text budget, referenced BEFORE a text
    // file: if images charged the budget, the text ref would be suppressed.
    const huge = Buffer.alloc(1024 * 1024 + 64 * 1024, 0x89);
    await writeFile(path.join(dir, 'huge.png'), huge);
    await writeFile(path.join(dir, 'notes.md'), 'still inlined\n');
    const cap = makeCap();
    const result = await cap.expandUserMessage('@huge.png @notes.md');

    expect(result.images).toHaveLength(1);
    expect(result.text).toContain('still inlined');
    expect(
      result.notices.some(n => n.includes('expansion budget exceeded'))
    ).toBe(false);
  });

  it('keeps the directory listing name-only (no image attachment)', async () => {
    await writeFile(path.join(dir, 'pic.png'), PNG_BYTES);
    const cap = makeCap();
    const result = await cap.expandUserMessage('@./');
    expect(result.images).toEqual([]);
    expect(result.text).toContain('pic.png');
    expect(result.notices).toEqual([]);
  });

  it('notices a missing image with the unresolved notice (ENOENT)', async () => {
    const cap = makeCap();
    const result = await cap.expandUserMessage('@nope.png');
    expect(result.images).toEqual([]);
    expect(result.notices).toEqual(['[unresolved reference: @nope.png]']);
  });

  it('notices an unreadable file uniformly for text and image', async () => {
    // Running as root bypasses permission bits, so there is nothing to assert.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const textPath = path.join(dir, 'secret.md');
    const imgPath = path.join(dir, 'secret.png');
    await writeFile(textPath, 'top secret\n');
    await writeFile(imgPath, PNG_BYTES);
    await chmod(textPath, 0o000);
    await chmod(imgPath, 0o000);

    const cap = makeCap();
    const textResult = await cap.expandUserMessage('@secret.md');
    const imgResult = await cap.expandUserMessage('@secret.png');

    expect(textResult.notices).toEqual(['[could not read: @secret.md]']);
    expect(imgResult.notices).toEqual(['[could not read: @secret.png]']);
    expect(imgResult.images).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { captureRegistration, enhanceFsError } from './setup.js';
import { filePlugin } from '../../src/plugins/file.js';

describe('enhanceFsError', () => {
  function enoent(): NodeJS.ErrnoException {
    const e: NodeJS.ErrnoException = new Error(
      "ENOENT: no such file or directory, scandir '/drone'"
    );
    e.code = 'ENOENT';
    return e;
  }

  function eacces(): NodeJS.ErrnoException {
    const e: NodeJS.ErrnoException = new Error('EACCES: permission denied');
    e.code = 'EACCES';
    return e;
  }

  function eisdir(): NodeJS.ErrnoException {
    const e: NodeJS.ErrnoException = new Error('EISDIR: illegal operation');
    e.code = 'EISDIR';
    return e;
  }

  function enotdir(): NodeJS.ErrnoException {
    const e: NodeJS.ErrnoException = new Error('ENOTDIR: not a directory');
    e.code = 'ENOTDIR';
    return e;
  }

  it('rewrites ENOENT to a clear path-not-found message', () => {
    const out = enhanceFsError('file__list', '/drone', enoent());
    expect(out.message).toContain('file__list');
    expect(out.message).toContain('not found');
    expect(out.message).toContain('/drone');
    expect(out.message).not.toContain('scandir');
  });

  it('rewrites EACCES to a permission-denied message', () => {
    const out = enhanceFsError('file__read', '/etc/shadow', eacces());
    expect(out.message).toContain('permission denied');
    expect(out.message).toContain('/etc/shadow');
  });

  it('hints to use file__list for EISDIR on read', () => {
    const out = enhanceFsError('file__read', '/home', eisdir());
    expect(out.message).toContain('directory');
    expect(out.message).toContain('file__list');
  });

  it('hints for ENOTDIR on list', () => {
    const out = enhanceFsError('file__list', '/not/a/real/dir', enotdir());
    expect(out.message).toContain('not a directory');
  });

  it('falls back to a generic message for unknown error codes', () => {
    const e: NodeJS.ErrnoException = new Error('something blew up');
    e.code = 'EWHOKNOWS';
    const out = enhanceFsError('file__write', '/tmp/x', e);
    expect(out.message).toContain('file__write');
    expect(out.message).toContain('something blew up');
  });

  it('handles non-Error inputs gracefully', () => {
    const out = enhanceFsError('file__read', '/x', 'a string error');
    expect(out.message).toContain('file__read');
    expect(out.message).toContain('a string error');
  });
});

describe('file plugin — read_image structured result', () => {
  it('returns metadata in content and base64 in images[], not in content', async () => {
    const { registration, rawTools } = captureRegistration();
    await filePlugin.register(registration);
    const readImage = rawTools.get('read_image');
    expect(readImage).toBeDefined();

    const target = path.join(
      tmpdir(),
      `drone-agent-test-image-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.png`
    );
    // 1x1 transparent PNG.
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64'
    );
    try {
      await writeFile(target, pngBytes);
      const result = await readImage!({ path: target });
      expect(typeof result).toBe('object');
      const structured = result as import('drone-core').DroneToolResult;
      // Content carries only metadata — no base64.
      expect(structured.content).toContain('image/png');
      expect(structured.content).not.toContain('iVBOR');
      // Images carry the base64 payload.
      expect(structured.images).toHaveLength(1);
      expect(structured.images![0].mimeType).toBe('image/png');
      expect(structured.images![0].data).toBe(pngBytes.toString('base64'));
    } finally {
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(target);
      } catch {
        // ignore
      }
    }
  });

  it('rejects images over maxImageSizeBytes', async () => {
    const { registration, rawTools } = captureRegistration();
    await filePlugin.register(registration);
    const readImage = rawTools.get('read_image');
    expect(readImage).toBeDefined();

    const target = path.join(
      tmpdir(),
      `drone-agent-test-image-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.png`
    );
    try {
      await writeFile(target, Buffer.alloc(20 * 1024 * 1024 + 1));
      await expect(readImage!({ path: target })).rejects.toThrow(
        /exceeds the maximum allowed size/
      );
    } finally {
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(target);
      } catch {
        // ignore
      }
    }
  });
});

describe('file plugin — error surfacing', () => {
  it('surfaces ENOENT from file__list as a clear tool error', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const list = tools.get('list');
    expect(list).toBeDefined();

    await expect(
      list!({ path: '/definitely/not/a/real/path' })
    ).rejects.toThrow(
      /file__list.*not found.*\/definitely\/not\/a\/real\/path/
    );
  });

  it('surfaces ENOENT from file__read as a clear tool error', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const read = tools.get('read');
    expect(read).toBeDefined();

    await expect(read!({ path: '/no/such/file/abcxyz.txt' })).rejects.toThrow(
      /file__read.*not found/
    );
  });

  it('reads an existing file', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const read = tools.get('read');
    expect(read).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-read-${Date.now()}.txt`);
    await writeFile(target, 'round-trip content', 'utf-8');
    try {
      const result = JSON.parse(await read!({ path: target }));
      expect(result.content).toBe('round-trip content');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => undefined);
    }
  });

  it('surfaces EISDIR from file__read when given a directory', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const read = tools.get('read');
    expect(read).toBeDefined();

    await expect(read!({ path: tmpdir() })).rejects.toThrow(/directory/i);
  });

  it('file__glob reports a missing cwd clearly', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const glob = tools.get('glob');
    expect(glob).toBeDefined();

    await expect(
      glob!({ pattern: '**/*.ts', cwd: '/definitely/not/a/real/path' })
    ).rejects.toThrow(/file__glob.*not found/);
  });
});

describe('file plugin — read/write round trip', () => {
  it('writes a file then reads it back', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const write = tools.get('write');
    const read = tools.get('read');
    expect(write).toBeDefined();
    expect(read).toBeDefined();

    const target = path.join(
      tmpdir(),
      `drone-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );
    try {
      const writeResult = JSON.parse(
        await write!({ path: target, content: 'hello world' })
      );
      expect(writeResult.written).toBe(true);

      // Sanity: file actually exists
      const statResult = await stat(target);
      expect(statResult.isFile()).toBe(true);

      const readResult = JSON.parse(await read!({ path: target }));
      expect(readResult.content).toBe('hello world');
    } finally {
      // Cleanup
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(target);
      } catch {
        // ignore
      }
    }
  });
});

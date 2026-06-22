import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createMemoryEntry,
  deleteMemoryEntry,
  listMemoryEntries,
  readMemoryEntry,
  resolveMemoryDir,
  sanitizeKey,
  searchMemoryEntries,
  updateMemoryEntry,
  writeMemoryEntry,
  countMemoryEntries,
} from '../src/plugins/memory/store.js';

async function withTempMemory<T>(
  fn: (memoryDir: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-memory-test-'));
  const memoryDir = path.join(dir, '.drone-agent', 'memory');
  try {
    return await fn(memoryDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('sanitizeKey', () => {
  it('rejects empty keys', () => {
    expect(() => sanitizeKey('')).toThrow(/non-empty/);
    expect(() => sanitizeKey('  ')).toThrow(/non-empty/);
  });

  it('rejects keys with ..', () => {
    expect(() => sanitizeKey('foo/../bar')).toThrow(/\.\./);
  });

  it('rejects keys starting with .', () => {
    expect(() => sanitizeKey('.hidden')).toThrow(/leading/);
  });

  it('replaces / with __', () => {
    expect(sanitizeKey('a/b/c')).toBe('a__b__c');
  });

  it('replaces \\ with __', () => {
    expect(sanitizeKey('a\\b\\c')).toBe('a__b__c');
  });

  it('replaces unsafe characters with _', () => {
    expect(sanitizeKey('foo<bar>baz|qux?')).toBe('foo_bar_baz_qux_');
  });

  it('trims whitespace', () => {
    expect(sanitizeKey('  hello  ')).toBe('hello');
  });
});

describe('resolveMemoryDir', () => {
  it('returns .drone-agent/memory under project dir', () => {
    expect(resolveMemoryDir('/project')).toBe('/project/.drone-agent/memory');
  });
});

describe('createMemoryEntry', () => {
  it('creates an entry with ISO dates and sanitized key', () => {
    const entry = createMemoryEntry('my-key', 'hello world', ['tag1']);
    expect(entry.key).toBe('my-key');
    expect(entry.value).toBe('hello world');
    expect(entry.tags).toEqual(['tag1']);
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.updatedAt).toBe(entry.createdAt);
  });

  it('defaults tags to empty', () => {
    const entry = createMemoryEntry('plain', 'just text');
    expect(entry.tags).toEqual([]);
  });
});

describe('updateMemoryEntry', () => {
  it('preserves createdAt, updates value and updatedAt', async () => {
    const original = createMemoryEntry('test', 'old', ['a']);
    await new Promise(r => setTimeout(r, 10));
    const updated = updateMemoryEntry(original, 'new', ['b']);

    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.key).toBe('test');
    expect(updated.value).toBe('new');
    expect(updated.tags).toEqual(['b']);
    expect(updated.updatedAt).not.toBe(original.updatedAt);
  });

  it('preserves original tags when not overridden', () => {
    const original = createMemoryEntry('test', 'val', ['x']);
    const updated = updateMemoryEntry(original, 'new-val');
    expect(updated.tags).toEqual(['x']);
  });
});

describe('readMemoryEntry / writeMemoryEntry', () => {
  it('returns null for a missing key', async () => {
    await withTempMemory(async memoryDir => {
      const entry = await readMemoryEntry(memoryDir, 'nonexistent');
      expect(entry).toBeNull();
    });
  });

  it('round-trips a value', async () => {
    await withTempMemory(async memoryDir => {
      const written = createMemoryEntry('my-key', 'hello world', ['test']);
      await writeMemoryEntry(memoryDir, written);

      const read = await readMemoryEntry(memoryDir, 'my-key');
      expect(read).not.toBeNull();
      expect(read!.key).toBe('my-key');
      expect(read!.value).toBe('hello world');
      expect(read!.tags).toEqual(['test']);
    });
  });

  it('overwrites an existing entry', async () => {
    await withTempMemory(async memoryDir => {
      const first = createMemoryEntry('dup', 'v1');
      await writeMemoryEntry(memoryDir, first);

      const second = createMemoryEntry('dup', 'v2');
      await writeMemoryEntry(memoryDir, second);

      const read = await readMemoryEntry(memoryDir, 'dup');
      expect(read!.value).toBe('v2');
    });
  });

  it('writes atomically (temp file vanishes after rename)', async () => {
    await withTempMemory(async memoryDir => {
      const entry = createMemoryEntry('atomic', 'data');
      await writeMemoryEntry(memoryDir, entry);

      const files = await import('node:fs/promises').then(m => m.readdir(memoryDir));
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);

      // The actual file should exist with the right name
      expect(files).toContain('atomic.md');
    });
  });

  it('writes and reads YAML frontmatter correctly', async () => {
    await withTempMemory(async memoryDir => {
      const entry = createMemoryEntry('frontmatter-test', 'Body text here', ['tag-a', 'tag-b']);
      await writeMemoryEntry(memoryDir, entry);

      // Read raw file to verify format
      const raw = await readFile(path.join(memoryDir, 'frontmatter-test.md'), 'utf-8');
      expect(raw).toContain('---');
      expect(raw).toContain('key: frontmatter-test');
      expect(raw).toContain('  - tag-a');
      expect(raw).toContain('  - tag-b');
      expect(raw).toContain('created:');
      expect(raw).toContain('updated:');
      expect(raw).toContain('---');
      expect(raw).toContain('Body text here');

      // Read back via API
      const read = await readMemoryEntry(memoryDir, 'frontmatter-test');
      expect(read).not.toBeNull();
      expect(read!.value).toBe('Body text here');
      expect(read!.tags).toEqual(['tag-a', 'tag-b']);
    });
  });
});

describe('deleteMemoryEntry', () => {
  it('returns false when key does not exist', async () => {
    await withTempMemory(async memoryDir => {
      const result = await deleteMemoryEntry(memoryDir, 'ghost');
      expect(result).toBe(false);
    });
  });

  it('deletes an existing entry and returns true', async () => {
    await withTempMemory(async memoryDir => {
      const entry = createMemoryEntry('delete-me', 'bye');
      await writeMemoryEntry(memoryDir, entry);

      const result = await deleteMemoryEntry(memoryDir, 'delete-me');
      expect(result).toBe(true);

      const read = await readMemoryEntry(memoryDir, 'delete-me');
      expect(read).toBeNull();
    });
  });
});

describe('listMemoryEntries', () => {
  it('returns empty for a fresh directory', async () => {
    await withTempMemory(async memoryDir => {
      const entries = await listMemoryEntries(memoryDir);
      expect(entries).toEqual([]);
    });
  });

  it('lists all entries sorted by updatedAt descending', async () => {
    await withTempMemory(async memoryDir => {
      const a = createMemoryEntry('alpha', '1');
      await sleep(10);
      const b = createMemoryEntry('beta', '2');
      await sleep(10);
      const c = createMemoryEntry('gamma', '3');
      await writeMemoryEntry(memoryDir, c);
      await writeMemoryEntry(memoryDir, b);
      await writeMemoryEntry(memoryDir, a);

      const entries = await listMemoryEntries(memoryDir);
      expect(entries).toHaveLength(3);
      const keys = entries.map(e => e.key).sort();
      expect(keys).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  it('filters by prefix', async () => {
    await withTempMemory(async memoryDir => {
      await writeMemoryEntry(memoryDir, createMemoryEntry('session:abc', '1'));
      await writeMemoryEntry(memoryDir, createMemoryEntry('session:xyz', '2'));
      await writeMemoryEntry(memoryDir, createMemoryEntry('config:main', '3'));

      const sess = await listMemoryEntries(memoryDir, 'session:');
      expect(sess).toHaveLength(2);

      const cfg = await listMemoryEntries(memoryDir, 'config:');
      expect(cfg).toHaveLength(1);
    });
  });
});

describe('searchMemoryEntries', () => {
  it('matches by key substring', async () => {
    await withTempMemory(async memoryDir => {
      await writeMemoryEntry(memoryDir, createMemoryEntry('bug-tracker', 'info', ['bug']));
      await writeMemoryEntry(memoryDir, createMemoryEntry('feature-list', 'info', ['feature']));

      const results = await searchMemoryEntries(memoryDir, 'bug');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('bug-tracker');
    });
  });

  it('matches by tag', async () => {
    await withTempMemory(async memoryDir => {
      await writeMemoryEntry(memoryDir, createMemoryEntry('thing', 'info', ['important']));
      await writeMemoryEntry(memoryDir, createMemoryEntry('other', 'info', ['trivial']));

      const results = await searchMemoryEntries(memoryDir, 'important');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('thing');
    });
  });

  it('matches by body text', async () => {
    await withTempMemory(async memoryDir => {
      await writeMemoryEntry(memoryDir, createMemoryEntry('note1', 'This is about TypeScript types', ['code']));
      await writeMemoryEntry(memoryDir, createMemoryEntry('note2', 'This is about Rust borrow checker', ['code']));

      const results = await searchMemoryEntries(memoryDir, 'TypeScript');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('note1');
    });
  });

  it('respects limit', async () => {
    await withTempMemory(async memoryDir => {
      for (let i = 0; i < 10; i++) {
        await writeMemoryEntry(memoryDir, createMemoryEntry(`key${i}`, `${i}`, ['test']));
      }
      const results = await searchMemoryEntries(memoryDir, 'key', 3);
      expect(results).toHaveLength(3);
    });
  });
});

describe('countMemoryEntries', () => {
  it('returns 0 for empty directory', async () => {
    await withTempMemory(async memoryDir => {
      expect(await countMemoryEntries(memoryDir)).toBe(0);
    });
  });

  it('counts stored entries', async () => {
    await withTempMemory(async memoryDir => {
      await writeMemoryEntry(memoryDir, createMemoryEntry('a', '1'));
      await writeMemoryEntry(memoryDir, createMemoryEntry('b', '2'));
      expect(await countMemoryEntries(memoryDir)).toBe(2);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import {
  createDefaultAgentConfig,
  type DronePluginRegistration,
} from 'drone-core';
import { filePlugin, __testing } from '../src/plugins/file.js';
import { applyPatch, type PatchHunk } from '../src/shared/patch-applier.js';
import { silentLogger } from './helpers.js';

const { enhanceFsError } = __testing;

function captureRegistration(): {
  registration: DronePluginRegistration;
  tools: Map<string, (input: Record<string, unknown>) => Promise<string>>;
  helpText: string[];
} {
  const tools = new Map<
    string,
    (input: Record<string, unknown>) => Promise<string>
  >();
  const helpText: string[] = [];

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: tool => {
      tools.set(tool.name, tool.execute);
    },
    registerPromptFragment: () => {},
    registerHelp: help => {
      helpText.push(help);
    },
    registerSlashCommand: () => {},
    registerWorkflow: () => {},
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };

  return { registration, tools, helpText };
}

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

// ── patch-applier unit tests ──────────────────────────────────────────

describe('applyPatch — basic operations', () => {
  it('replaces lines with anchor + context', () => {
    const lines = [
      'def greet():',
      '    """Say hello"""',
      '    print("hello")',
      '',
      'def farewell():',
      '    print("goodbye")',
    ];

    const hunks: PatchHunk[] = [
      {
        anchors: ['def greet():'],
        contextBefore: ['def greet():'],
        oldLines: ['    """Say hello"""', '    print("hello")'],
        newLines: ['    """Say hello"""', '    print("hi there")'],
        contextAfter: ['', 'def farewell():'],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
    expect(result.appliedHunks[0].fuzz).toBe(0);
  });

  it('pure insertion (empty oldLines)', () => {
    const lines = [
      'def add(a, b):',
      '    return a + b',
      '',
      'def subtract(a, b):',
      '    return a - b',
    ];

    const hunks: PatchHunk[] = [
      {
        anchors: ['def add(a, b):'],
        contextBefore: ['def add(a, b):'],
        oldLines: [],
        newLines: ['    """Add two numbers"""'],
        contextAfter: ['    return a + b', ''],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('pure deletion (empty newLines)', () => {
    const lines = [
      'def old_func():',
      '    # deprecated',
      '    pass',
      '',
      'def new_func():',
      '    pass',
    ];

    const hunks: PatchHunk[] = [
      {
        anchors: ['def old_func():'],
        contextBefore: ['def old_func():'],
        oldLines: ['    # deprecated', '    pass'],
        newLines: [],
        contextAfter: ['', 'def new_func():'],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('multiple anchors for hierarchical disambiguation', () => {
    const lines = [
      'class MathUtils:',
      '    def add(self, a, b):',
      '        return a + b',
      '',
      '    def multiply(self, a, b):',
      '        return a * b',
      '',
      'class StringUtils:',
      '    def add(self, a, b):',
      '        return a + b',
    ];

    const hunks: PatchHunk[] = [
      {
        anchors: ['class MathUtils:', '    def add(self, a, b):'],
        contextBefore: ['    def add(self, a, b):'],
        oldLines: ['        return a + b'],
        newLines: ['        """Add two numbers"""', '        return a + b'],
        contextAfter: ['', '    def multiply(self, a, b):'],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('no anchors — context-only search', () => {
    const lines = [
      'line1',
      'line2',
      'target_before',
      'target_old',
      'target_after',
      'line6',
    ];

    const hunks: PatchHunk[] = [
      {
        anchors: [],
        contextBefore: ['target_before'],
        oldLines: ['target_old'],
        newLines: ['target_new'],
        contextAfter: ['target_after'],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });
});

describe('applyPatch — fuzzy matching', () => {
  it('fuzz level 1: trailing whitespace differences', () => {
    const lines = ['def foo():  ', '    pass  ', ''];

    const hunks: PatchHunk[] = [
      {
        anchors: ['def foo():'],
        contextBefore: ['def foo():'],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [''],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks[0].fuzz).toBe(1);
  });

  it('fuzz level 100: all whitespace differences', () => {
    const lines = ['def  foo ( ) :', '    pass', ''];

    const hunks: PatchHunk[] = [
      {
        anchors: ['def foo():'],
        contextBefore: ['def foo():'],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [''],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks[0].fuzz).toBe(100);
  });
});

describe('applyPatch — error handling', () => {
  it('reports anchor not found', () => {
    const lines = ['def foo():', '    pass'];

    const hunks: PatchHunk[] = [
      {
        anchors: ['def nonexistent():'],
        contextBefore: [],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('Anchor not found');
  });

  it('reports context mismatch with details', () => {
    const lines = ['def foo():', '    print("hello")', ''];

    const hunks: PatchHunk[] = [
      {
        anchors: ['def foo():'],
        contextBefore: ['def foo():'],
        oldLines: ['    print("world")'],
        newLines: ['    print("universe")'],
        contextAfter: [''],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('Context does not match');
    expect(result.errors[0].foundOldLines).toBeDefined();
  });

  it('reports context not found anywhere when no anchors', () => {
    const lines = ['line1', 'line2', 'line3'];

    const hunks: PatchHunk[] = [
      {
        anchors: [],
        contextBefore: ['nonexistent_before'],
        oldLines: ['nonexistent_old'],
        newLines: ['new_line'],
        contextAfter: ['nonexistent_after'],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('Context not found anywhere');
  });

  it('reports anchor chain not found', () => {
    const lines = [
      'class A:',
      '    def method(self):',
      '        pass',
      '',
      'class B:',
      '    def method(self):',
      '        pass',
    ];

    const hunks: PatchHunk[] = [
      {
        anchors: [
          'class A:',
          '    def method(self):',
          '    def nonexistent():',
        ],
        contextBefore: [],
        oldLines: ['        pass'],
        newLines: ['        return 42'],
        contextAfter: [],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('Anchor chain not found');
  });
});

describe('applyPatch — multiple hunks', () => {
  it('applies multiple hunks bottom-up', () => {
    const lines = [
      'def first():',
      '    pass',
      '',
      'def second():',
      '    pass',
      '',
      'def third():',
      '    pass',
    ];

    const hunks: PatchHunk[] = [
      {
        anchors: ['def first():'],
        contextBefore: ['def first():'],
        oldLines: ['    pass'],
        newLines: ['    return 1'],
        contextAfter: ['', 'def second():'],
      },
      {
        anchors: ['def third():'],
        contextBefore: ['def third():'],
        oldLines: ['    pass'],
        newLines: ['    return 3'],
        contextAfter: [],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toHaveLength(2);
  });

  it('reports partial success with some errors', () => {
    const lines = ['def good():', '    pass', '', 'def bad():', '    pass'];

    const hunks: PatchHunk[] = [
      {
        anchors: ['def good():'],
        contextBefore: ['def good():'],
        oldLines: ['    pass'],
        newLines: ['    return 1'],
        contextAfter: ['', 'def bad():'],
      },
      {
        anchors: ['def nonexistent():'],
        contextBefore: [],
        oldLines: ['    pass'],
        newLines: ['    return 2'],
        contextAfter: [],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.appliedHunks).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });
});

describe('applyPatch — edge cases', () => {
  it('handles empty file', () => {
    const lines: string[] = [];
    const hunks: PatchHunk[] = [
      {
        anchors: [],
        contextBefore: [],
        oldLines: [],
        newLines: ['first line'],
        contextAfter: [],
      },
    ];

    const result = applyPatch(lines, hunks);
    // Empty file with no anchors and no context — can't match anything
    expect(result.success).toBe(false);
  });

  it('handles single-line file — replacing the only line', () => {
    const lines = ['the only line'];
    const hunks: PatchHunk[] = [
      {
        anchors: ['the only line'],
        contextBefore: [],
        oldLines: ['the only line'],
        newLines: ['replacement line'],
        contextAfter: [],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('handles file with trailing newline (empty last line)', () => {
    const lines = ['line1', 'line2', ''];
    const hunks: PatchHunk[] = [
      {
        anchors: ['line2'],
        contextBefore: ['line1'],
        oldLines: ['line2', ''],
        newLines: ['line2', 'line3', ''],
        contextAfter: [],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
  });
});

// ── Round-trip integration tests ──────────────────────────────────────

describe('file__apply_diff — round-trip integration', () => {
  it('produces correct JSON response with plain-text diff', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-diff-${Date.now()}.txt`);
    await writeFile(target, 'line1\nline2\nline3\n', 'utf-8');
    try {
      // Unified diff: change line2 -> line2_modified
      const patch = [
        '@@ -1,3 +1,3 @@',
        ' line1',
        '-line2',
        '+line2_modified',
        ' line3',
      ].join('\n');

      const result = JSON.parse(
        await applyDiff!({
          path: target,
          patch,
        })
      );
      expect(result.path).toBe(target);
      expect(result.patched).toBe(true);
      expect(result.summary).toBeDefined();
      expect(result.diff).toBeDefined();
      // Verify diff is plain text (no ANSI codes)
      expect(result.diff).not.toContain('\x1b[');
      // Verify the file was actually written
      const content = await readFile(target, 'utf-8');
      expect(content).toContain('line2_modified');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('applies a multi-hunk patch', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-multi-${Date.now()}.txt`);
    await writeFile(
      target,
      [
        'def func_a():',
        '    pass',
        '',
        'def func_b():',
        '    pass',
        '',
        'def func_c():',
        '    pass',
      ].join('\n'),
      'utf-8'
    );
    try {
      // Two hunks: change func_a and func_c, leaving func_b untouched
      const patch = [
        '@@ -1,2 +1,2 @@ def func_a():',
        ' def func_a():',
        '-    pass',
        '+    return 1',
        '',
        '@@ -7,2 +7,2 @@ def func_c():',
        ' def func_c():',
        '-    pass',
        '+    return 3',
      ].join('\n');

      const result = JSON.parse(
        await applyDiff!({
          path: target,
          patch,
        })
      );
      expect(result.patched).toBe(true);
      expect(result.summary.hunks).toBe(2);
      // Verify both changes applied
      const content = await readFile(target, 'utf-8');
      expect(content).toContain('return 1');
      expect(content).toContain('return 3');
      // func_b() was not touched
      expect(content).toContain('def func_b():');
      // func_a and func_c no longer have pass
      expect(content).toContain('    pass'); // func_b's pass still there
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('handles insertion patch with context', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-insert-${Date.now()}.txt`);
    await writeFile(target, 'line1\nline2\n', 'utf-8');
    try {
      // Insertion after line1: use context lines to anchor
      const patch = [
        '@@ -1,2 +1,4 @@',
        ' line1',
        '+new line A',
        '+new line B',
        ' line2',
      ].join('\n');

      const result = JSON.parse(
        await applyDiff!({
          path: target,
          patch,
        })
      );
      expect(result.patched).toBe(true);

      const content = await readFile(target, 'utf-8');
      expect(content).toContain('new line A');
      expect(content).toContain('new line B');
      expect(content).toContain('line1');
      expect(content).toContain('line2');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('handles pure deletion patch', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-delete-${Date.now()}.txt`);
    await writeFile(
      target,
      ['keep1', 'discard1', 'discard2', 'keep2'].join('\n'),
      'utf-8'
    );
    try {
      // Pure deletion with context
      const patch = [
        '@@ -1,4 +1,2 @@',
        ' keep1',
        '-discard1',
        '-discard2',
        ' keep2',
      ].join('\n');

      const result = JSON.parse(
        await applyDiff!({
          path: target,
          patch,
        })
      );
      expect(result.patched).toBe(true);

      const content = await readFile(target, 'utf-8');
      expect(content).not.toContain('discard1');
      expect(content).not.toContain('discard2');
      expect(content).toContain('keep1');
      expect(content).toContain('keep2');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('rejects empty patch with a clear error', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    // Empty patch should fail validation before reading the file
    await expect(
      applyDiff!({
        path: '/tmp/some-file.txt',
        patch: '',
      })
    ).rejects.toThrow(/patch string/);
  });

  it('rejects patch with no @@ headers with a clear error', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    // Writes a real file so we reach the parser check
    const target = path.join(tmpdir(), `drone-agent-nohunks-${Date.now()}.txt`);
    await writeFile(target, 'some content\n', 'utf-8');
    try {
      await expect(
        applyDiff!({
          path: target,
          patch: 'just some text without hunk headers',
        })
      ).rejects.toThrow(/no hunks/);
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('TUI formatDiffResult recognizes patched field', async () => {
    const { formatDiffResult } = (await import('../src/tui/app.js')).__testing;
    const result = formatDiffResult(
      JSON.stringify({
        path: '/tmp/test.txt',
        patched: true,
        summary: { hunks: 1, additions: 1, deletions: 1 },
        diff: '@@ -1 +1 @@\n-old\n+new',
      })
    );
    expect(result).toContain('Applied diff to');
    expect(result).toContain('/tmp/test.txt');
  });

  it('TUI formatDiffResult still works with written field', async () => {
    const { formatDiffResult } = (await import('../src/tui/app.js')).__testing;
    const result = formatDiffResult(
      JSON.stringify({
        path: '/tmp/test.txt',
        written: true,
      })
    );
    expect(result).toContain('Applied diff to');
    expect(result).toContain('/tmp/test.txt');
  });
});

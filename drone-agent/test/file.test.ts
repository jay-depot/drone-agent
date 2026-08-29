import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import {
  createDefaultAgentConfig,
  toToolResultContent,
  type DronePluginRegistration,
} from 'drone-core';
import { filePlugin, __testing } from '../src/plugins/file.js';
import {
  applyPatch,
  type ChangeZoneLine,
  type PatchHunk,
} from '../src/shared/patch-applier.js';
import { silentLogger } from './helpers.js';

const { enhanceFsError } = __testing;

/**
 * Build a PatchHunk with a default empty changeZone. Most test hunks have no
 * interleaved context, so this keeps the literals concise. Pass `changeZone`
 * explicitly when the test needs interleaved context.
 */
function makeHunk(
  h: Omit<PatchHunk, 'changeZone'> & { changeZone?: ChangeZoneLine[] }
): PatchHunk {
  return { changeZone: [], ...h };
}

function captureRegistration(): {
  registration: DronePluginRegistration;
  tools: Map<string, (input: Record<string, unknown>) => Promise<string>>;
  rawTools: Map<
    string,
    (
      input: Record<string, unknown>
    ) => Promise<string | import('drone-core').DroneToolResult>
  >;
  helpText: string[];
  promptFragments: Array<{
    key: string;
    render: () => Promise<string | false>;
  }>;
} {
  const tools = new Map<
    string,
    (input: Record<string, unknown>) => Promise<string>
  >();
  const rawTools = new Map<
    string,
    (
      input: Record<string, unknown>
    ) => Promise<string | import('drone-core').DroneToolResult>
  >();
  const helpText: string[] = [];
  const promptFragments: Array<{
    key: string;
    render: () => Promise<string | false>;
  }> = [];

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: tool => {
      rawTools.set(tool.name, tool.execute);
      tools.set(tool.name, async (input: Record<string, unknown>) =>
        toToolResultContent(await tool.execute(input))
      );
    },
    registerPromptFragment: fragment => {
      promptFragments.push(fragment);
    },
    registerHelp: help => {
      helpText.push(help);
    },
    registerSlashCommand: () => {},
    registerWorkflow: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
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
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
  };

  return { registration, tools, rawTools, helpText, promptFragments };
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

// ── patch-applier unit tests ──────────────────────────────────────────

describe('applyPatch — basic operations', () => {
  it('replaces lines with context-anchored match', () => {
    const lines = [
      'def greet():',
      '    """Say hello"""',
      '    print("hello")',
      '',
      'def farewell():',
      '    print("goodbye")',
    ];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: ['def greet():'],
        contextBefore: ['def greet():'],
        oldLines: ['    """Say hello"""', '    print("hello")'],
        newLines: ['    """Say hello"""', '    print("hi there")'],
        contextAfter: ['', 'def farewell():'],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
    expect(result.appliedHunks[0].fuzz).toBe(0);
  });

  it('pure insertion (empty oldLines) locates via contextBefore', () => {
    const lines = [
      'def add(a, b):',
      '    return a + b',
      '',
      'def subtract(a, b):',
      '    return a - b',
    ];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: ['def add(a, b):'],
        contextBefore: ['def add(a, b):'],
        oldLines: [],
        newLines: ['    """Add two numbers"""'],
        contextAfter: ['    return a + b', ''],
      }),
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
      makeHunk({
        anchors: ['def old_func():'],
        contextBefore: ['def old_func():'],
        oldLines: ['    # deprecated', '    pass'],
        newLines: [],
        contextAfter: ['', 'def new_func():'],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('context disambiguates between duplicate oldLines blocks', () => {
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
      makeHunk({
        anchors: [],
        contextBefore: ['    def add(self, a, b):'],
        oldLines: ['        return a + b'],
        newLines: ['        """Add two numbers"""', '        return a + b'],
        contextAfter: ['', '    def multiply(self, a, b):'],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('no anchors, unique oldLines — step 1 match applies', () => {
    const lines = [
      'line1',
      'line2',
      'target_before',
      'target_old',
      'target_after',
      'line6',
    ];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['target_before'],
        oldLines: ['target_old'],
        newLines: ['target_new'],
        contextAfter: ['target_after'],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedHunks).toHaveLength(1);
  });
});

describe('applyPatch — fuzzy matching (step 1.5 aggressive fuzz)', () => {
  it('fuzz level 1: trailing whitespace differences (step 1 finds it)', () => {
    const lines = ['def foo():  ', '    pass  ', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: ['def foo():'],
        contextBefore: ['def foo():'],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [''],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
  });

  it('fuzz level 100: internal whitespace differences (step 1.5 aggressive)', () => {
    // File has `def  foo ( ) :` (extra spaces); oldLines has `def foo():`.
    // Step 1 exact match fails; step 1.5 aggressive collapse matches.
    const lines = ['def  foo ( ) :', '    pass', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['def foo():'],
        oldLines: ['def foo():', '    pass'],
        newLines: ['def foo():', '    return 42'],
        contextAfter: [''],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks[0].fuzz).toBe(200);
  });

  it('step 1.5 handles line-break reflow (1-line oldLines ↔ multi-line file)', () => {
    // File has a function call wrapped across 3 lines; oldLines is 1 line.
    // The collapse must match exactly (punctuation is preserved), so the
    // file's wrapped form must collapse to the same string as oldLines.
    const lines = ['foo(a,', '  b,', '  c)', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['foo(a, b, c)'],
        newLines: ['foo(a, b, c, d)'],
        contextAfter: [''],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks[0].fuzz).toBe(200);
    // The 3-line file span should have been replaced with the new 1-line.
    expect(result.patchedLines).toEqual(['foo(a, b, c, d)', '']);
  });

  it('step 1.5 handles line-break join (multi-line oldLines ↔ 1-line file)', () => {
    // File has a single-line call; oldLines is wrapped across 3 lines.
    // oldLines must collapse to the same string as the file line.
    const lines = ['foo(a, b, c)', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['foo(a,', '  b,', '  c)'],
        newLines: ['foo(a, b, c, d)'],
        contextAfter: [''],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks[0].fuzz).toBe(200);
    expect(result.patchedLines).toEqual(['foo(a, b, c, d)', '']);
  });
});

describe('applyPatch — error handling (Type 1/2/3 failures)', () => {
  it('Type 2: reports old code not found when oldLines absent from file', () => {
    const lines = ['def foo():', '    pass'];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    nonexistent_old_line'],
        newLines: ['    return 42'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].failureType).toBe('type2');
    expect(result.errors[0].message).toContain('not found');
  });

  it('Type 1: reports multiple matches when oldLines appears more than once', () => {
    const lines = ['    pass', '', '    pass'];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].failureType).toBe('type1');
    expect(result.errors[0].matchSites).toBeDefined();
    expect(result.errors[0].matchSites!.length).toBe(2);
  });

  it('Type 1: cheat sheet includes reworked hunks', () => {
    const lines = ['    pass', '', '    pass', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    const sites = result.errors[0].matchSites!;
    for (const site of sites) {
      expect(site.reworkedHunk).toContain('@@');
      expect(site.reworkedHunk).toContain('-    pass');
      expect(site.reworkedHunk).toContain('+    return 42');
    }
  });

  it('Type 2: suggests closest file spans via Levenshtein', () => {
    // oldLines has a typo; the file has the correct spelling.
    const lines = ['def foo():', '    return 42', ''];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    return 43'],
        newLines: ['    return 99'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.errors[0].failureType).toBe('type2');
    const suggestions = result.errors[0].suggestions ?? [];
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(5);
    // Closest suggestion should be near `    return 42`.
    expect(suggestions[0].content).toContain('return 42');
  });
});

describe('applyPatch — multiple hunks (top-to-bottom)', () => {
  it('applies multiple hunks top-to-bottom', () => {
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
      makeHunk({
        anchors: [],
        contextBefore: ['def first():'],
        oldLines: ['    pass'],
        newLines: ['    return 1'],
        contextAfter: ['', 'def second():'],
      }),
      makeHunk({
        anchors: [],
        contextBefore: ['def third():'],
        oldLines: ['    pass'],
        newLines: ['    return 3'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toHaveLength(2);
  });

  it('later hunks see earlier hunks changes', () => {
    // First hunk changes `    pass` (first occurrence) to `    return 1`.
    // Second hunk targets the remaining `    pass` — now unique.
    const lines = ['def good():', '    pass', '', 'def bad():', '    pass'];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['def good():'],
        oldLines: ['    pass'],
        newLines: ['    return 1'],
        contextAfter: ['', 'def bad():'],
      }),
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    pass'],
        newLines: ['    return 2'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    // After first hunk applies, only one `    pass` remains, so second applies.
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toHaveLength(2);
  });

  it('reports partial success: one hunk applies, one fails', () => {
    const lines = ['def good():', '    pass', '', 'def bad():', '    pass'];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['def good():'],
        oldLines: ['    pass'],
        newLines: ['    return 1'],
        contextAfter: ['', 'def bad():'],
      }),
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    nonexistent_old'],
        newLines: ['    return 2'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(false);
    expect(result.appliedHunks).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].failureType).toBe('type2');
  });
});

describe('applyPatch — edge cases', () => {
  it('handles empty file with pure insertion (no context)', () => {
    const lines: string[] = [];
    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: [],
        newLines: ['first line'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    // Empty file with empty oldLines and no context → inserts at start.
    expect(result.success).toBe(true);
    expect(result.patchedLines).toEqual(['first line']);
  });

  it('handles single-line file — replacing the only line', () => {
    const lines = ['the only line'];
    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['the only line'],
        newLines: ['replacement line'],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toHaveLength(1);
  });

  it('handles file with trailing newline (empty last line)', () => {
    const lines = ['line1', 'line2', ''];
    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: ['line1'],
        oldLines: ['line2', ''],
        newLines: ['line2', 'line3', ''],
        contextAfter: [],
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
  });
});

describe('applyPatch — lineHint tie-breaking', () => {
  it('lineHint breaks ties between otherwise-equivalent matches', () => {
    const lines = ['    pass', '', '    pass', '', '    pass'];

    const hunks: PatchHunk[] = [
      makeHunk({
        anchors: [],
        contextBefore: [],
        oldLines: ['    pass'],
        newLines: ['    return 42'],
        contextAfter: [],
        lineHint: 3, // closest to the second `    pass` (line 3)
      }),
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.appliedHunks).toHaveLength(1);
    // Second `    pass` is at line 3 (1-based).
    expect(result.appliedHunks[0].appliedAtLine).toBe(3);
  });
});

describe('applyPatch — interleaved context (regression)', () => {
  it('preserves interleaved context lines in the change zone', () => {
    const lines = ['keep1', 'old1', 'keep2', 'old2', 'keep3'];

    const changeZone: ChangeZoneLine[] = [
      { kind: '-', content: 'old1' },
      { kind: '+', content: 'new1' },
      { kind: ' ', content: 'keep2' },
      { kind: '-', content: 'old2' },
      { kind: '+', content: 'new2' },
    ];

    const hunks: PatchHunk[] = [
      {
        anchors: [],
        contextBefore: ['keep1'],
        changeZone,
        oldLines: ['old1', 'keep2', 'old2'],
        newLines: ['new1', 'keep2', 'new2'],
        contextAfter: ['keep3'],
      },
    ];

    const result = applyPatch(lines, hunks);
    expect(result.success).toBe(true);
    expect(result.patchedLines).toEqual([
      'keep1',
      'new1',
      'keep2',
      'new2',
      'keep3',
    ]);
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

  it('applies a multi-hunk patch top-to-bottom', async () => {
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

  it('handles interleaved context patch (round-trip)', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-inter-${Date.now()}.txt`);
    await writeFile(
      target,
      ['keep1', 'old1', 'keep2', 'old2', 'keep3'].join('\n'),
      'utf-8'
    );
    try {
      const patch = [
        '@@ -1,5 +1,5 @@',
        ' keep1',
        '-old1',
        '+new1',
        ' keep2',
        '-old2',
        '+new2',
        ' keep3',
      ].join('\n');

      const result = JSON.parse(await applyDiff!({ path: target, patch }));
      expect(result.patched).toBe(true);

      const content = await readFile(target, 'utf-8');
      // keep2 should still be present (preserved interleaved context).
      expect(content).toContain('keep1');
      expect(content).toContain('new1');
      expect(content).toContain('keep2');
      expect(content).toContain('new2');
      expect(content).toContain('keep3');
      expect(content).not.toContain('old1');
      expect(content).not.toContain('old2');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => {});
    }
  });

  it('partial success: writes file with applied hunks, reports failures', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);

    const applyDiff = tools.get('apply_diff');
    expect(applyDiff).toBeDefined();

    const target = path.join(tmpdir(), `drone-agent-partial-${Date.now()}.txt`);
    await writeFile(
      target,
      ['def good():', '    pass', '', 'def bad():', '    pass'].join('\n'),
      'utf-8'
    );
    try {
      // First hunk applies (context disambiguates). Second hunk fails (old code absent).
      const patch = [
        '@@ -1,3 +1,3 @@',
        ' def good():',
        '-    pass',
        '+    return 1',
        ' ',
        '@@ -99,1 +99,1 @@',
        '-    nonexistent_old_line',
        '+    return 2',
      ].join('\n');

      let threw: Error | undefined;
      try {
        JSON.parse(await applyDiff!({ path: target, patch }));
      } catch (e) {
        threw = e as Error;
      }

      // The tool throws on failure (since not all hunks succeeded), but the
      // file should have been written with the successful hunk applied.
      expect(threw).toBeDefined();
      expect(threw!.message).toContain('failed to apply');

      const content = await readFile(target, 'utf-8');
      expect(content).toContain('return 1');
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
});

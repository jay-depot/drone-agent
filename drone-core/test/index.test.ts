import { describe, expect, it, vi } from 'vitest';
import {
  applyAgentConfigLayer,
  deepMerge,
  createConsoleLogger,
  createDefaultAgentConfig,
  filterByGlobPatterns,
  getCanonicalToolName,
  matchGlob,
  type DroneAgentConfig,
  type PartialDroneAgentConfig,
  commandExistsOnPath,
  resolveDroneExecutable,
} from '../src/index.js';

describe('createConsoleLogger', () => {
  it('prefixes messages with the scope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const logger = createConsoleLogger('scope-x');
      logger.info('hello');
      logger.warn('careful');
      logger.error('boom');

      expect(log).toHaveBeenCalledWith('[scope-x] hello');
      expect(warn).toHaveBeenCalledWith('[scope-x] careful');
      expect(error).toHaveBeenCalledWith('[scope-x] boom');
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe('getCanonicalToolName', () => {
  it('joins plugin id and tool name with double underscore', () => {
    expect(getCanonicalToolName('file', 'read')).toBe('file__read');
    expect(getCanonicalToolName('mcp', 'github.list_prs')).toBe(
      'mcp__github.list_prs'
    );
  });
});

describe('createDefaultAgentConfig', () => {
  it('returns a complete config with sensible defaults', () => {
    const config = createDefaultAgentConfig();
    expect(config.enabledPlugins).toEqual([]);
    expect(config.activePersona).toBeNull();
    expect(config.ollama.host).toMatch(/^https?:\/\//);
    expect(config.ollama.model).toBeTruthy();
    expect(config.session.contextWindowTokens).toBeGreaterThan(0);
    expect(config.session.responseReserveTokens).toBeGreaterThan(0);
    expect(config.lsp.servers).toEqual({});
    expect(config.mcp.servers).toEqual({});
    expect(config.compaction.strategy).toBe('summary-drop');
    expect(config.compaction.nudgeMarginPercent).toBe(10);
  });

  it('returns a fresh object each call', () => {
    const a = createDefaultAgentConfig();
    const b = createDefaultAgentConfig();
    expect(a).not.toBe(b);
    expect(a.lsp.servers).not.toBe(b.lsp.servers);
    a.enabledPlugins.push('mutate-me');
    expect(b.enabledPlugins).toEqual([]);
  });
});

describe('applyAgentConfigLayer', () => {
  const base: DroneAgentConfig = createDefaultAgentConfig();

  it('returns the base config when the layer is empty', () => {
    const merged = applyAgentConfigLayer(base, {});
    expect(merged).toEqual(base);
  });

  it('replaces scalar fields when present in the layer', () => {
    const layer: PartialDroneAgentConfig = {
      enabledPlugins: ['file', 'search'],
      systemPrompt: 'Custom prompt',
      activePersona: 'reviewer',
    };
    const merged = applyAgentConfigLayer(base, layer);
    expect(merged.enabledPlugins).toEqual(['file', 'search']);
    expect(merged.systemPrompt).toBe('Custom prompt');
    expect(merged.activePersona).toBe('reviewer');
  });

  it('allows activePersona to be explicitly cleared with null', () => {
    const withPersona = applyAgentConfigLayer(base, { activePersona: 'p' });
    const cleared = applyAgentConfigLayer(withPersona, { activePersona: null });
    expect(cleared.activePersona).toBeNull();
  });

  it('deep-merges nested ollama / session / compaction sections', () => {
    const merged = applyAgentConfigLayer(base, {
      ollama: { model: 'qwen3:8b' },
      session: { contextWindowTokens: 65536 },
      compaction: { softThresholdPercent: 50 },
    });
    expect(merged.ollama).toEqual({ ...base.ollama, model: 'qwen3:8b' });
    expect(merged.session).toEqual({
      ...base.session,
      contextWindowTokens: 65536,
    });
    expect(merged.compaction.softThresholdPercent).toBe(50);
    expect(merged.compaction.enabled).toBe(base.compaction.enabled);
    expect(merged.compaction.nudgeMarginPercent).toBe(
      base.compaction.nudgeMarginPercent
    );
  });

  it('replaces LSP server map but merges LSP scalar fields', () => {
    const layer: PartialDroneAgentConfig = {
      lsp: {
        enabled: false,
        servers: {
          ts: {
            transport: 'stdio',
            command: 'typescript-language-server',
            args: ['--stdio'],
          },
        },
      },
    };
    const merged = applyAgentConfigLayer(base, layer);
    expect(merged.lsp.enabled).toBe(false);
    expect(Object.keys(merged.lsp.servers)).toEqual(['ts']);
  });

  it('replaces MCP server map but merges MCP scalar fields', () => {
    const layer: PartialDroneAgentConfig = {
      mcp: {
        retryCount: 5,
        servers: {
          remote: {
            transport: 'streamable_http',
            url: 'https://example.com/mcp',
          },
        },
      },
    };
    const merged = applyAgentConfigLayer(base, layer);
    expect(merged.mcp.retryCount).toBe(5);
    expect(Object.keys(merged.mcp.servers)).toEqual(['remote']);
    expect(merged.mcp.compatibilityMode).toBe(base.mcp.compatibilityMode);
  });

  it('keeps the base server map when the layer omits servers', () => {
    const populated = applyAgentConfigLayer(base, {
      lsp: { servers: { x: { transport: 'stdio', command: 'x' } } },
    });
    const merged = applyAgentConfigLayer(populated, {
      lsp: { enabled: false },
    });
    expect(Object.keys(merged.lsp.servers)).toEqual(['x']);
  });
});

describe('matchGlob', () => {
  it('matches exact names', () => {
    expect(matchGlob('exec__run', 'exec__run')).toBe(true);
    expect(matchGlob('exec__run', 'exec__list')).toBe(false);
  });

  it('matches wildcard * across a single segment', () => {
    expect(matchGlob('exec__*', 'exec__run')).toBe(true);
    expect(matchGlob('exec__*', 'exec__list')).toBe(true);
    expect(matchGlob('exec__*', 'exec__run__extra')).toBe(true);
  });

  it('matches wildcard * across multiple segments', () => {
    expect(matchGlob('mcp__*', 'mcp__filesystem__read')).toBe(true);
    expect(matchGlob('mcp__*', 'mcp__filesystem')).toBe(true);
    // mcp__* requires at least a __ + something after it
    expect(matchGlob('mcp__*', 'mcp')).toBe(false);
  });

  it('matches single-character wildcard ?', () => {
    expect(matchGlob('file__rea?', 'file__read')).toBe(true);
    expect(matchGlob('file__rea?', 'file__real')).toBe(true);
    expect(matchGlob('file__rea?', 'file__reads')).toBe(false);
  });

  it('matches the catch-all *', () => {
    expect(matchGlob('*', 'exec__run')).toBe(true);
    expect(matchGlob('*', 'anything__here')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(matchGlob('Exec__Run', 'exec__run')).toBe(false);
  });
});

describe('filterByGlobPatterns', () => {
  const items = [
    'exec__run',
    'exec__list',
    'file__read',
    'file__write',
    'mcp__filesystem__read',
    'mcp__filesystem__write',
    'search__text',
  ];

  it('returns all items when patterns is empty', () => {
    expect(filterByGlobPatterns(items, [])).toEqual(items);
  });

  it('returns all items when patterns is undefined', () => {
    expect(filterByGlobPatterns(items, undefined)).toEqual(items);
  });

  it('filters by inclusion patterns', () => {
    const result = filterByGlobPatterns(items, ['exec__*']);
    expect(result).toEqual(['exec__run', 'exec__list']);
  });

  it('filters by multiple inclusion patterns', () => {
    const result = filterByGlobPatterns(items, ['exec__*', 'file__*']);
    expect(result).toEqual([
      'exec__run',
      'exec__list',
      'file__read',
      'file__write',
    ]);
  });

  it('excludes items matching ! patterns', () => {
    const result = filterByGlobPatterns(items, ['*', '!exec__run']);
    expect(result).not.toContain('exec__run');
    expect(result).toContain('exec__list');
    expect(result).toContain('file__read');
  });

  it('combines inclusion and exclusion', () => {
    const result = filterByGlobPatterns(items, ['exec__*', '!exec__run']);
    expect(result).toEqual(['exec__list']);
  });

  it('exclusion-only patterns include everything except matches', () => {
    const result = filterByGlobPatterns(items, ['!mcp__*']);
    expect(result).not.toContain('mcp__filesystem__read');
    expect(result).not.toContain('mcp__filesystem__write');
    expect(result).toContain('exec__run');
    expect(result).toContain('file__read');
  });

  it('handles multiple exclusions', () => {
    const result = filterByGlobPatterns(items, ['*', '!exec__*', '!file__*']);
    expect(result).toEqual([
      'mcp__filesystem__read',
      'mcp__filesystem__write',
      'search__text',
    ]);
  });

  it('returns empty array when nothing matches', () => {
    const result = filterByGlobPatterns(items, ['nonexistent__*']);
    expect(result).toEqual([]);
  });
});

describe('deepMerge', () => {
  it('skips undefined values in the overlay', () => {
    const base: Record<string, unknown> = { a: 1, b: 2 };
    const result = deepMerge(base, { a: undefined }, {});
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('replaces fields listed in replace', () => {
    const base: Record<string, unknown> = { a: 1, b: 2 };
    const result = deepMerge(base, { a: 99 }, { replace: ['a'] });
    expect(result).toEqual({ a: 99, b: 2 });
  });

  it('replaces fields listed in replaceNullable even when null', () => {
    const base: Record<string, unknown> = { a: 1, b: 2 };
    const result = deepMerge(base, { a: null }, { replaceNullable: ['a'] });
    expect(result).toEqual({ a: null, b: 2 });
  });

  it('shallow-merges fields listed in merge', () => {
    const base: Record<string, unknown> = { a: { x: 1, y: 2 }, b: 3 };
    const result = deepMerge(base, { a: { y: 99, z: 100 } }, { merge: ['a'] });
    expect(result).toEqual({ a: { x: 1, y: 99, z: 100 }, b: 3 });
  });

  it('merges and deduplicates arrays listed in mergeArrays', () => {
    const base: Record<string, unknown> = { a: [1, 2, 3] };
    const result = deepMerge(base, { a: [3, 4, 5] }, { mergeArrays: ['a'] });
    expect(result).toEqual({ a: [1, 2, 3, 4, 5] });
  });

  it('recursively deep-merges nested specs', () => {
    const base: Record<string, unknown> = {
      outer: {
        inner: { a: 1, b: 2 },
        other: 'keep',
      },
    };
    const result = deepMerge(
      base,
      { outer: { inner: { b: 99, c: 3 } } },
      { deepMerge: { outer: { deepMerge: { inner: {} } } } }
    );
    expect(result).toEqual({
      outer: { inner: { a: 1, b: 99, c: 3 }, other: 'keep' },
    });
  });

  it('defaults unlisted objects to shallow spread merge', () => {
    const base: Record<string, unknown> = { a: { x: 1, y: 2 } };
    const result = deepMerge(base, { a: { y: 99 } }, {});
    expect(result).toEqual({ a: { x: 1, y: 99 } });
  });

  it('defaults unlisted scalars to replace', () => {
    const base: Record<string, unknown> = { a: 1, b: 'hello' };
    const result = deepMerge(base, { a: 99, b: 'world' }, {});
    expect(result).toEqual({ a: 99, b: 'world' });
  });

  it('does not mutate the base object', () => {
    const base: Record<string, unknown> = { a: { x: 1 } };
    const result = deepMerge(base, { a: { y: 2 } }, { merge: ['a'] });
    expect(base.a).toEqual({ x: 1 });
    expect(result.a).toEqual({ x: 1, y: 2 });
  });
});

describe('applyAgentConfigLayer — tui nested merge', () => {
  it('deep-merges tui.syntaxHighlighting.colors', () => {
    const base = createDefaultAgentConfig();
    const merged = applyAgentConfigLayer(base, {
      tui: {
        syntaxHighlighting: {
          colors: { keyword: 'red' },
        },
      },
    } as PartialDroneAgentConfig);
    expect(merged.tui.syntaxHighlighting.colors.keyword).toBe('red');
    // Other colors from the base should be preserved
    expect(merged.tui.syntaxHighlighting.colors.function).toBe('cyan');
    expect(merged.tui.syntaxHighlighting.codeBackground).toBe('gray');
  });
});

describe('applyAgentConfigLayer — promptFile.files merge+dedup', () => {
  it('merges and deduplicates promptFile.files arrays', () => {
    const base = createDefaultAgentConfig();
    const withFiles = applyAgentConfigLayer(base, {
      promptFile: { files: ['a.md', 'b.md'] },
    });
    const merged = applyAgentConfigLayer(withFiles, {
      promptFile: { files: ['b.md', 'c.md'] },
    });
    expect(merged.promptFile.files).toEqual(['a.md', 'b.md', 'c.md']);
  });
});

describe('commandExistsOnPath', () => {
  it('returns false for an empty command', async () => {
    expect(await commandExistsOnPath('')).toBe(false);
  });

  it('returns true for the current Node executable', async () => {
    expect(await commandExistsOnPath(process.execPath)).toBe(true);
  });

  it('returns false for a non-existent absolute path', async () => {
    expect(await commandExistsOnPath('/definitely/not/a/real/binary-xyz')).toBe(
      false
    );
  });
});

describe('resolveDroneExecutable', () => {
  it('resolves an explicit absolute command name', async () => {
    const result = await resolveDroneExecutable({
      commandName: process.execPath,
    });
    expect(result).toBe(process.execPath);
  });

  it('falls back to argv[1] when the command is not found', async () => {
    const result = await resolveDroneExecutable({
      commandName: '/definitely/not/a/real/binary-xyz',
      fallbackArgv1: process.execPath,
    });
    expect(result).toBe(process.execPath);
  });

  it('throws when the command and fallback are both missing', async () => {
    await expect(
      resolveDroneExecutable({
        commandName: '/definitely/not/a/real/binary-xyz',
      })
    ).rejects.toThrow(/Unable to resolve executable/);
  });

  it('throws when the command and fallback are both missing, including fallback in message', async () => {
    await expect(
      resolveDroneExecutable({
        commandName: '/definitely/not/a/real/binary-xyz',
        fallbackArgv1: '/also/definitely/not/real',
      })
    ).rejects.toThrow(/fallback path/);
  });
});

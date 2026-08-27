import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDefaultAgentConfig,
  toToolResultContent,
  type DronePluginRegistration,
  type DronePromptFragment,
  type DroneToolDefinition,
} from 'drone-core';
import {
  searchPlugin,
  parseSearchFilesArgs,
  extractSnippet,
} from '../src/plugins/search/index.js';
import { silentLogger } from './helpers.js';

function captureRegistration(): {
  registration: DronePluginRegistration;
  tools: Map<
    string,
    {
      execute: (input: Record<string, unknown>) => Promise<string>;
      description?: string;
    }
  >;
  fragments: Map<string, DronePromptFragment>;
  runOnPluginsLoaded: () => Promise<void>;
} {
  const tools = new Map<
    string,
    {
      execute: (input: Record<string, unknown>) => Promise<string>;
      description?: string;
    }
  >();
  const fragments = new Map<string, DronePromptFragment>();
  let onPluginsLoadedCallback: (() => Promise<void>) | undefined;
  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: tool => {
      tools.set(tool.name, {
        execute: async (input: Record<string, unknown>) =>
          toToolResultContent(await tool.execute(input)),
        description: tool.description,
      });
    },
    registerPromptFragment: fragment => {
      fragments.set(fragment.key, fragment);
    },
    registerHelp: () => {},
    registerSlashCommand: () => {},
    registerWorkflow: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    hooks: {
      onPluginsLoaded: callback => {
        onPluginsLoadedCallback = callback;
      },
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
  return {
    registration,
    tools,
    fragments,
    runOnPluginsLoaded: async () => {
      await onPluginsLoadedCallback?.();
    },
  };
}

describe('search plugin — text (regex)', () => {
  it('returns an empty result (not an error) when nothing matches in an existing dir', async () => {
    const { registration, tools } = captureRegistration();
    await searchPlugin.register(registration);
    const text = tools.get('text')?.execute;
    expect(text).toBeDefined();

    const fs = await import('node:fs/promises');
    const searchRoot = path.join(tmpdir(), `drone-search-${Date.now()}`);
    await fs.mkdir(searchRoot, { recursive: true });

    try {
      const result = JSON.parse(
        await text!({ pattern: 'definitely_no_match_xyzzy', path: searchRoot })
      ) as { resultCount: number; results: unknown[]; truncated: boolean };

      expect(result.resultCount).toBe(0);
      expect(result.results).toEqual([]);
      expect(result.truncated).toBe(false);
    } finally {
      await fs.rmdir(searchRoot).catch(() => undefined);
    }
  });

  it('returns a clear error (not a crash) for a missing search path', async () => {
    const { registration, tools } = captureRegistration();
    await searchPlugin.register(registration);
    const text = tools.get('text')?.execute;
    expect(text).toBeDefined();

    await expect(
      text!({
        pattern: 'foo',
        path: '/definitely/not/a/real/path/xyz',
      })
    ).rejects.toThrow(/search__text/);
  });

  it('rejects empty patterns', async () => {
    const { registration, tools } = captureRegistration();
    await searchPlugin.register(registration);
    const text = tools.get('text')?.execute;
    expect(text).toBeDefined();

    await expect(text!({ pattern: '' })).rejects.toThrow(/non-empty/);
    await expect(text!({ pattern: '   ' })).rejects.toThrow(/non-empty/);
  });

  it('finds a real match and reports file/line/content', async () => {
    const { registration, tools } = captureRegistration();
    await searchPlugin.register(registration);
    const text = tools.get('text')?.execute;
    expect(text).toBeDefined();

    const fs = await import('node:fs/promises');
    const searchRoot = path.join(tmpdir(), `drone-search-match-${Date.now()}`);
    await fs.mkdir(searchRoot, { recursive: true });
    const filePath = path.join(searchRoot, 'sample.txt');
    await fs.writeFile(filePath, 'line1\nmatch_here_xyz\nline3\n', 'utf-8');

    try {
      const result = JSON.parse(
        await text!({ pattern: 'match_here_xyz', path: searchRoot })
      ) as {
        resultCount: number;
        results: { file: string; line: number; content: string }[];
      };
      expect(result.resultCount).toBeGreaterThanOrEqual(1);
      expect(result.results[0]?.line).toBe(2);
      expect(result.results[0]?.content).toContain('match_here_xyz');
    } finally {
      await fs.rm(searchRoot, { recursive: true, force: true });
    }
  });

  it('returns a message when mode="semantic" with no embedding providers', async () => {
    const { registration, tools } = captureRegistration();
    await searchPlugin.register(registration);
    const text = tools.get('text')?.execute;
    expect(text).toBeDefined();
    const result = JSON.parse(
      await text!({ pattern: 'foo', mode: 'semantic' })
    );
    expect(result.note).toMatch(/beacon connection/i);
  });
});

// ── Semantic search exclude passthrough ─────────────────────────────

describe('search plugin — semantic exclude passthrough', () => {
  it('sends configured exclude patterns as query params', async () => {
    const tools = new Map<
      string,
      (input: Record<string, unknown>) => Promise<string>
    >();
    const config = createDefaultAgentConfig();
    config.search = {
      enabled: true,
      paths: [{ path: '/proj', exclude: ['*.log', '**/dist/**'] }],
    };

    const registration: DronePluginRegistration = {
      logger: silentLogger(),
      getConfig: () => config,
      registerTool: tool => {
        tools.set(tool.name, async (input: Record<string, unknown>) =>
          toToolResultContent(await tool.execute(input))
        );
      },
      registerPromptFragment: () => {},
      registerHelp: () => {},
      registerSlashCommand: () => {},
      registerWorkflow: () => {},
      unregisterPluginTools: () => {},
      unregisterTool: () => {},
      mountTool: () => undefined,
      unmountTool: () => {},
      listMountedTools: () => [],
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
      request: <T>() =>
        ({
          getBeaconUrl: () => 'http://beacon:3457',
          getAgentId: () => 'agent-1',
        }) as T,
      runWorkflow: async () => ({ toolResult: '{}' }),
      requestElicitation: () => undefined,
    };

    await searchPlugin.register(registration);
    const text = tools.get('text');
    expect(text).toBeDefined();

    let capturedUrl = '';
    const fetchMock = vi.fn(async (url: string) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({
          query: 'q',
          resultCount: 0,
          truncated: false,
          results: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await text!({ pattern: 'foo', mode: 'semantic' });
      expect(capturedUrl).toContain('exclude=*.log');
      expect(capturedUrl).toContain('exclude=**%2Fdist%2F**');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── /search-files flag parser ───────────────────────────────────────

describe('parseSearchFilesArgs', () => {
  it('parses a plain regex pattern with defaults', () => {
    const parsed = parseSearchFilesArgs(['foo']);
    expect(parsed).toEqual({
      pattern: 'foo',
      mode: 'regex',
      path: process.cwd(),
      limit: 10,
      glob: null,
    });
  });

  it('parses --semantic, --path, --limit, and --glob', () => {
    const parsed = parseSearchFilesArgs([
      'how does compaction work',
      '--semantic',
      '--path',
      '/proj',
      '--limit',
      '5',
      '--glob',
      '*.ts',
    ]);
    expect(parsed).toEqual({
      pattern: 'how does compaction work',
      mode: 'semantic',
      path: '/proj',
      limit: 5,
      glob: '*.ts',
    });
  });

  it('joins multiple positional words into the pattern', () => {
    const parsed = parseSearchFilesArgs(['how', 'does', 'compaction', 'work']);
    expect(parsed?.pattern).toBe('how does compaction work');
  });

  it('returns null for an unknown flag', () => {
    expect(parseSearchFilesArgs(['foo', '--bogus'])).toBeNull();
  });

  it('returns null for a missing flag value', () => {
    expect(parseSearchFilesArgs(['foo', '--path'])).toBeNull();
    expect(parseSearchFilesArgs(['foo', '--limit'])).toBeNull();
  });

  it('returns null for a non-numeric or zero limit', () => {
    expect(parseSearchFilesArgs(['foo', '--limit', 'abc'])).toBeNull();
    expect(parseSearchFilesArgs(['foo', '--limit', '0'])).toBeNull();
  });

  it('returns null for an empty pattern', () => {
    expect(parseSearchFilesArgs([])).toBeNull();
    expect(parseSearchFilesArgs(['   '])).toBeNull();
  });
});

// ── extractSnippet ──────────────────────────────────────────────────

describe('extractSnippet', () => {
  it('picks the sentence with the most query-term overlap', () => {
    const chunk =
      'The cat sat on the mat. ' +
      'The dog barked loudly at the mailman. ' +
      'Compaction summarizes old turns to save context.';
    const snippet = extractSnippet('compaction summarizes turns', chunk);
    expect(snippet).toContain('Compaction summarizes old turns');
  });

  it('trims a long sentence to a window around the first match', () => {
    const longSentence =
      'This is a very long sentence that goes on and on about the compaction ' +
      'plugin and how it evicts the oldest summaries first and compacts the ' +
      'oldest non-summary turns when the turn count exceeds the limit, and ' +
      'there is a lot more filler text here to make it exceed the window.';
    const snippet = extractSnippet('compaction evicts summaries', longSentence);
    expect(snippet.length).toBeLessThanOrEqual(200);
    expect(snippet).toContain('compaction');
  });

  it('falls back to the first sentence when no terms match', () => {
    const chunk = 'First sentence here. Second sentence about zebras.';
    const snippet = extractSnippet('quantum entanglement', chunk);
    expect(snippet).toContain('First sentence here');
  });

  it('returns an empty string for empty chunk text', () => {
    expect(extractSnippet('foo', '')).toBe('');
  });
});

// ── /search-files slash command ─────────────────────────────────────

describe('search plugin — /search-files slash command', () => {
  function captureSlashCommand(): {
    registration: DronePluginRegistration;
    slashCommands: Map<
      string,
      (ctx: {
        args: string[];
        logger: { info: (m: string) => void; error: (m: string) => void };
        engine: { executeTool: (n: string, i: unknown) => Promise<string> };
      }) => Promise<boolean>
    >;
  } {
    const slashCommands = new Map();
    const registration: DronePluginRegistration = {
      logger: silentLogger(),
      getConfig: () => createDefaultAgentConfig(),
      registerTool: () => {},
      registerPromptFragment: () => {},
      registerHelp: () => {},
      registerSlashCommand: cmd => {
        slashCommands.set(cmd.command, cmd.handler);
      },
      registerWorkflow: () => {},
      unregisterPluginTools: () => {},
      unregisterTool: () => {},
      mountTool: () => undefined,
      unmountTool: () => {},
      listMountedTools: () => [],
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
    return { registration, slashCommands };
  }

  it('registers the /search-files command', async () => {
    const { registration, slashCommands } = captureSlashCommand();
    await searchPlugin.register(registration);
    expect(slashCommands.has('/search-files')).toBe(true);
  });

  it('formats regex results as file:line with content', async () => {
    const { registration, slashCommands } = captureSlashCommand();
    await searchPlugin.register(registration);
    const handler = slashCommands.get('/search-files');

    const logged: string[] = [];
    const ctx = {
      args: ['foo'],
      logger: { info: (m: string) => logged.push(m), error: () => {} },
      engine: {
        executeTool: async () =>
          JSON.stringify({
            pattern: 'foo',
            searchPath: '/proj',
            resultCount: 2,
            truncated: false,
            results: [
              { file: '/proj/a.ts', line: 3, content: 'const foo = 1;' },
              { file: '/proj/b.ts', line: 7, content: 'foo()' },
            ],
          }),
      },
    };

    const handled = await handler!(ctx as never);
    expect(handled).toBe(true);
    expect(logged[0]).toContain('2 results');
    expect(logged[0]).toContain('/proj/a.ts:3');
    expect(logged[0]).toContain('const foo = 1;');
    expect(logged[0]).toContain('/proj/b.ts:7');
  });

  it('formats semantic results as score + file + snippet', async () => {
    const { registration, slashCommands } = captureSlashCommand();
    await searchPlugin.register(registration);
    const handler = slashCommands.get('/search-files');

    const logged: string[] = [];
    const ctx = {
      args: ['how does compaction work', '--semantic'],
      logger: { info: (m: string) => logged.push(m), error: () => {} },
      engine: {
        executeTool: async () =>
          JSON.stringify({
            query: 'how does compaction work',
            resultCount: 1,
            truncated: false,
            results: [
              {
                file: '/proj/compaction.ts',
                chunkIndex: 0,
                content:
                  'The compaction plugin evicts the oldest summaries first. ' +
                  'It compacts the oldest non-summary turns when the count exceeds the limit.',
                score: 0.82,
              },
            ],
          }),
      },
    };

    const handled = await handler!(ctx as never);
    expect(handled).toBe(true);
    expect(logged[0]).toContain('1 result');
    expect(logged[0]).toContain('0.82');
    expect(logged[0]).toContain('/proj/compaction.ts');
    expect(logged[0]).toContain('compaction');
  });

  it('surfaces the no-beacon note for semantic mode', async () => {
    const { registration, slashCommands } = captureSlashCommand();
    await searchPlugin.register(registration);
    const handler = slashCommands.get('/search-files');

    const logged: string[] = [];
    const ctx = {
      args: ['foo', '--semantic'],
      logger: { info: (m: string) => logged.push(m), error: () => {} },
      engine: {
        executeTool: async () =>
          JSON.stringify({
            note: 'Semantic search requires a beacon connection.',
          }),
      },
    };

    const handled = await handler!(ctx as never);
    expect(handled).toBe(true);
    expect(logged[0]).toContain('beacon connection');
  });

  it('prints usage when no pattern is given', async () => {
    const { registration, slashCommands } = captureSlashCommand();
    await searchPlugin.register(registration);
    const handler = slashCommands.get('/search-files');

    const logged: string[] = [];
    const ctx = {
      args: [],
      logger: { info: (m: string) => logged.push(m), error: () => {} },
      engine: { executeTool: async () => '{}' },
    };

    const handled = await handler!(ctx as never);
    expect(handled).toBe(true);
    expect(logged[0]).toContain('Usage: /search-files');
  });
});

// ── Prompt surface ──────────────────────────────────────────────────

describe('search plugin — prompt surface', () => {
  it('tool description leads with two-mode framing and follow-up guidance', async () => {
    const { registration, tools } = captureRegistration();
    await searchPlugin.register(registration);

    const description = tools.get('text')?.description ?? '';
    expect(description).toContain('semantic');
    expect(description).toContain('regex');
    expect(description).toContain('file__read');
  });

  it('registers the # Search Index fragment with decision guidance', async () => {
    const { registration, fragments, runOnPluginsLoaded } =
      captureRegistration();
    await searchPlugin.register(registration);

    const config = createDefaultAgentConfig();
    config.search = {
      enabled: true,
      paths: [{ path: '/tmp/some-dir' }],
    };
    registration.getConfig = () => config;
    registration.request = <T>() =>
      ({
        getBeaconUrl: () => 'http://beacon.test:3457',
        getAgentId: () => 'agent-under-test',
      }) as T;

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ indexed: true, paths: ['/tmp/some-dir'] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await runOnPluginsLoaded();
    } finally {
      vi.unstubAllGlobals();
    }

    const fragment = fragments.get('search-indexed-directories');
    expect(fragment).toBeDefined();
    expect(fragment!.phase).toBe('header');

    const rendered = await fragment!.render();
    expect(rendered).not.toBe(false);
    const text = String(rendered);

    expect(text.startsWith('# Search Index')).toBe(true);
    expect(text).toContain('/tmp/some-dir');
    expect(text).toContain('mode: "semantic"');
    expect(text).toContain('regex');
    expect(text).toContain('concept');
    expect(text).toContain('file__read');
    expect(text).toContain('minScore');
  });
});

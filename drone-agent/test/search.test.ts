import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import {
  createDefaultAgentConfig,
  type DronePluginRegistration,
} from 'drone-core';
import { searchPlugin } from '../src/plugins/search/index.js';
import { SearchStore, semanticSearch } from 'drone-swarm-common';
import { silentLogger } from './helpers.js';

function captureRegistration(): {
  registration: DronePluginRegistration;
  tools: Map<string, (input: Record<string, unknown>) => Promise<string>>;
} {
  const tools = new Map<
    string,
    (input: Record<string, unknown>) => Promise<string>
  >();
  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: tool => {
      tools.set(tool.name, tool.execute);
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
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };
  return { registration, tools };
}

describe('search plugin — text (regex)', () => {
  it('returns an empty result (not an error) when nothing matches in an existing dir', async () => {
    const { registration, tools } = captureRegistration();
    await searchPlugin.register(registration);
    const text = tools.get('text');
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
    const text = tools.get('text');
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
    const text = tools.get('text');
    expect(text).toBeDefined();

    await expect(text!({ pattern: '' })).rejects.toThrow(/non-empty/);
    await expect(text!({ pattern: '   ' })).rejects.toThrow(/non-empty/);
  });

  it('finds a real match and reports file/line/content', async () => {
    const { registration, tools } = captureRegistration();
    await searchPlugin.register(registration);
    const text = tools.get('text');
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
    const text = tools.get('text');
    expect(text).toBeDefined();
    const result = JSON.parse(
      await text!({ pattern: 'foo', mode: 'semantic' })
    );
    expect(result.note).toMatch(/beacon connection/i);
  });
});

// ── SearchStore tests ────────────────────────────────────────────────

describe('SearchStore', () => {
  let tmpDir: string;
  let store: SearchStore;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'drone-search-store-'));
    const dbPath = path.join(tmpDir, 'search.db');
    store = new SearchStore(dbPath);
    store.open();
  });

  afterAll(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates tables and stores metadata', () => {
    store.setMeta('providerId', 'test-provider');
    store.setMeta('dimensions', '4');
    expect(store.getMeta('providerId')).toBe('test-provider');
    expect(store.getMeta('dimensions')).toBe('4');
  });

  it('inserts and retrieves file hashes', () => {
    store.upsertFile('/test', 'file1.ts', 'abc123');
    expect(store.getFileHash('/test', 'file1.ts')).toBe('abc123');
  });

  it('updates existing file hashes', () => {
    store.upsertFile('/test', 'file1.ts', 'def456');
    expect(store.getFileHash('/test', 'file1.ts')).toBe('def456');
  });

  it('inserts and retrieves chunks', () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    store.insertChunk('/test', 'file1.ts', 0, 'hello world', embedding);

    const chunks = store.getChunksForFile('/test', 'file1.ts');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('hello world');
    expect(chunks[0].chunk_index).toBe(0);
  });

  it('deletes chunks when file is removed', () => {
    store.deleteChunksForFile('/test', 'file1.ts');
    const chunks = store.getChunksForFile('/test', 'file1.ts');
    expect(chunks).toHaveLength(0);
  });

  it('removes stale files', () => {
    store.upsertFile('/test', 'stale.ts', 'stale');
    const existing = new Set<string>();
    const removed = store.removeStaleFiles('/test', existing);
    expect(removed).toContain('stale.ts');
    expect(store.getFileHash('/test', 'stale.ts')).toBeUndefined();
  });

  it('returns all file paths', () => {
    store.upsertFile('/test', 'a.ts', 'aaa');
    store.upsertFile('/test', 'b.ts', 'bbb');
    const paths = store.getAllFilePaths('/test');
    expect(paths).toContain('a.ts');
    expect(paths).toContain('b.ts');
  });

  it('returns chunk count', () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    store.insertChunk('/test', 'a.ts', 0, 'chunk a', embedding);
    store.insertChunk('/test', 'b.ts', 0, 'chunk b', embedding);
    expect(store.getChunkCount('/test')).toBeGreaterThanOrEqual(2);
  });
});

// ── Semantic search tests ─────────────────────────────────────────────

describe('semanticSearch', () => {
  let tmpDir: string;
  let store: SearchStore;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'drone-search-semantic-'));
    const dbPath = path.join(tmpDir, 'search.db');
    store = new SearchStore(dbPath);
    store.open();

    // Insert file records first (required by foreign key constraint)
    store.upsertFile('/test', 'animals.txt', 'hash1');
    store.upsertFile('/test', 'vehicles.txt', 'hash2');

    // Insert some test chunks with known embeddings
    // Embedding for "cat" concept: [1, 0, 0, 0]
    store.insertChunk(
      '/test',
      'animals.txt',
      0,
      'The cat sat on the mat',
      new Float32Array([1, 0, 0, 0])
    );
    // Embedding for "dog" concept: [0, 1, 0, 0]
    store.insertChunk(
      '/test',
      'animals.txt',
      1,
      'The dog barked loudly',
      new Float32Array([0, 1, 0, 0])
    );
    // Embedding for "car" concept: [0, 0, 1, 0]
    store.insertChunk(
      '/test',
      'vehicles.txt',
      0,
      'The car drove fast',
      new Float32Array([0, 0, 1, 0])
    );
  });

  afterAll(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns results sorted by cosine similarity', async () => {
    // A mock provider that returns a fixed embedding for any query
    const mockProvider = {
      id: 'mock',
      name: 'Mock Provider',
      dimensions: 4,
      maxTokens: 8192,
      getEmbedding: async (_text: string) => new Float32Array([1, 0, 0, 0]), // matches "cat"
    };

    const results = await semanticSearch({
      store,
      provider: mockProvider,
      query: 'cat',
      maxResults: 10,
    });

    expect(results).toHaveLength(3);
    // First result should be the cat chunk (score ~1.0)
    expect(results[0].text).toContain('cat');
    expect(results[0].score).toBeGreaterThan(0.9);
  });

  it('respects maxResults', async () => {
    const mockProvider = {
      id: 'mock',
      name: 'Mock Provider',
      dimensions: 4,
      maxTokens: 8192,
      getEmbedding: async (_text: string) => new Float32Array([1, 0, 0, 0]),
    };

    const results = await semanticSearch({
      store,
      provider: mockProvider,
      query: 'cat',
      maxResults: 1,
    });

    expect(results).toHaveLength(1);
  });

  it('filters by minScore', async () => {
    const mockProvider = {
      id: 'mock',
      name: 'Mock Provider',
      dimensions: 4,
      maxTokens: 8192,
      getEmbedding: async (_text: string) => new Float32Array([0, 0, 0, 1]), // matches nothing
    };

    const results = await semanticSearch({
      store,
      provider: mockProvider,
      query: 'unknown',
      maxResults: 10,
      minScore: 0.5,
    });

    expect(results).toHaveLength(0);
  });
});

/**
 * @vitest-environment node
 *
 * Unit tests for MCP server-description generation + caching. Covers the
 * prompt shape, the cache hit/miss path, and the `promptVersion` cache-bust
 * that forces regeneration after the summarizer prompt changes.
 *
 * `os.homedir()` is redirected to a temp directory so the tests never touch
 * the developer's real ~/.drone-agent/cache/mcp/server-descriptions.json.
 *
 * ESM module namespaces are NOT spyable (`vi.spyOn(os, 'homedir')` silently
 * no-ops), so the module under test is imported dynamically after
 * `vi.resetModules()` + `vi.doMock`. The module reads the DEFAULT export
 * (`import * as os from 'node:os'`), so the mock must override `default`
 * as well as the named export.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DroneChatRequest,
  DroneLlmCapability,
  DroneLogger,
  DroneResolvedModelRole,
} from 'drone-core';

type DescriptionModule =
  typeof import('../src/plugins/mcp/server-description.js');

let testHomeDir = '';

const TOOLS = [
  { name: 'search', description: 'Search the web.' },
  { name: 'fetch', description: 'Fetch a URL.' },
];

function cacheFilePath(): string {
  return path.join(
    testHomeDir,
    '.drone-agent',
    'cache',
    'mcp',
    'server-descriptions.json'
  );
}

type DescriptionEntry = {
  description: string;
  generatedAt: string;
  promptVersion: number;
};

async function writeCacheFile(
  contents: Record<string, DescriptionEntry>
): Promise<void> {
  const file = cacheFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(contents, null, 2), 'utf-8');
}

async function readCacheFile(): Promise<Record<string, DescriptionEntry>> {
  return JSON.parse(await readFile(cacheFilePath(), 'utf-8')) as Record<
    string,
    DescriptionEntry
  >;
}

async function loadModule(): Promise<DescriptionModule> {
  return import('../src/plugins/mcp/server-description.js');
}

type FakeLlm = {
  capability: DroneLlmCapability;
  calls: DroneChatRequest[];
};

function fakeLlm(reply = 'Searches the web and fetches pages.'): FakeLlm {
  const calls: DroneChatRequest[] = [];
  const role: DroneResolvedModelRole = {
    providerId: 'openrouter',
    model: 'summarizer-model',
    provider: {
      chat: async (input: DroneChatRequest) => {
        calls.push(input);
        return { message: reply };
      },
    },
  };
  const capability = {
    resolveModelForRole: () => role,
  } as unknown as DroneLlmCapability;
  return { capability, calls };
}

function recordingLogger(): { logger: DroneLogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      info: () => {},
      warn: (message: string) => warnings.push(message),
      error: () => {},
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  testHomeDir = await mkdtemp(path.join(os.tmpdir(), 'drone-mcp-desc-'));
  vi.doMock('node:os', async importOriginal => {
    const actual = await importOriginal<typeof import('node:os')>();
    const mocked = { ...actual, homedir: () => testHomeDir };
    return { ...mocked, default: mocked };
  });
});

afterEach(async () => {
  vi.doUnmock('node:os');
  vi.resetModules();
  if (testHomeDir) {
    await rm(testHomeDir, { recursive: true, force: true });
  }
  testHomeDir = '';
});

describe('getOrCreateServerDescription', () => {
  it('generates, caches, and returns a description on a cache miss', async () => {
    const { getOrCreateServerDescription } = await loadModule();
    const { capability, calls } = fakeLlm();
    const { logger } = recordingLogger();

    const result = await getOrCreateServerDescription(
      'demo',
      TOOLS,
      capability,
      logger
    );

    expect(result).toBe('Searches the web and fetches pages.');
    expect(calls).toHaveLength(1);

    const cache = await readCacheFile();
    expect(cache.demo.description).toBe('Searches the web and fetches pages.');
    expect(typeof cache.demo.promptVersion).toBe('number');
    expect(typeof cache.demo.generatedAt).toBe('string');
  });

  it('sends the tuned one-sentence instruction as the system message', async () => {
    const { getOrCreateServerDescription } = await loadModule();
    const { capability, calls } = fakeLlm();
    const { logger } = recordingLogger();

    await getOrCreateServerDescription('demo', TOOLS, capability, logger);

    const system = calls[0].messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('ONE short sentence');
    expect(system.content).toContain('20 words or fewer');
  });

  it('sends the tool list as the user message', async () => {
    const { getOrCreateServerDescription } = await loadModule();
    const { capability, calls } = fakeLlm();
    const { logger } = recordingLogger();

    await getOrCreateServerDescription('demo', TOOLS, capability, logger);

    const user = calls[0].messages[1];
    expect(user.role).toBe('user');
    expect(JSON.parse(user.content as string)).toEqual([
      { name: 'search', description: 'Search the web.' },
      { name: 'fetch', description: 'Fetch a URL.' },
    ]);
  });

  it('reuses a cached description without calling the LLM again', async () => {
    const { getOrCreateServerDescription } = await loadModule();
    const first = fakeLlm();
    await getOrCreateServerDescription(
      'demo',
      TOOLS,
      first.capability,
      recordingLogger().logger
    );

    const second = fakeLlm('This should never be used.');
    const result = await getOrCreateServerDescription(
      'demo',
      TOOLS,
      second.capability,
      recordingLogger().logger
    );

    expect(result).toBe('Searches the web and fetches pages.');
    expect(second.calls).toHaveLength(0);
  });

  it('regenerates when the cached entry has a stale promptVersion', async () => {
    const { getOrCreateServerDescription } = await loadModule();
    await writeCacheFile({
      demo: {
        description: 'An outdated multi-sentence summary. It rambles on.',
        generatedAt: '2026-01-01T00:00:00.000Z',
        promptVersion: 1,
      },
    });

    const { capability, calls } = fakeLlm('A fresh one-liner.');
    const result = await getOrCreateServerDescription(
      'demo',
      TOOLS,
      capability,
      recordingLogger().logger
    );

    expect(result).toBe('A fresh one-liner.');
    expect(calls).toHaveLength(1);

    const cache = await readCacheFile();
    expect(cache.demo.description).toBe('A fresh one-liner.');
    expect(cache.demo.promptVersion).toBeGreaterThan(1);
  });

  it('returns undefined without writing when no LLM is available', async () => {
    const { getOrCreateServerDescription } = await loadModule();
    const { logger } = recordingLogger();

    const result = await getOrCreateServerDescription(
      'demo',
      TOOLS,
      undefined,
      logger
    );

    expect(result).toBeUndefined();
    await expect(readCacheFile()).rejects.toThrow();
  });

  it('fails open and warns when generation throws', async () => {
    const { getOrCreateServerDescription } = await loadModule();
    const role: DroneResolvedModelRole = {
      providerId: 'openrouter',
      model: 'summarizer-model',
      provider: {
        chat: async () => {
          throw new Error('provider exploded');
        },
      },
    };
    const capability = {
      resolveModelForRole: () => role,
    } as unknown as DroneLlmCapability;
    const { logger, warnings } = recordingLogger();

    const result = await getOrCreateServerDescription(
      'demo',
      TOOLS,
      capability,
      logger
    );

    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('demo');
    expect(warnings[0]).toContain('provider exploded');
  });
});

describe('readCachedDescriptions', () => {
  it('returns only current-version entries, keyed by server id', async () => {
    const { getOrCreateServerDescription, readCachedDescriptions } =
      await loadModule();
    const current = fakeLlm('Current server description.');
    await getOrCreateServerDescription(
      'current',
      TOOLS,
      current.capability,
      recordingLogger().logger
    );

    const written = await readCacheFile();
    await writeCacheFile({
      ...written,
      stale: {
        description: 'Old description.',
        generatedAt: '2026-01-01T00:00:00.000Z',
        promptVersion: 1,
      },
    });

    const descriptions = await readCachedDescriptions();
    expect(descriptions.current).toBe('Current server description.');
    expect(descriptions.stale).toBeUndefined();
  });

  it('returns an empty object when no cache file exists', async () => {
    const { readCachedDescriptions } = await loadModule();
    expect(await readCachedDescriptions()).toEqual({});
  });
});

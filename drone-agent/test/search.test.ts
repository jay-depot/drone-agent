import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDefaultAgentConfig,
  type DronePluginRegistration,
} from 'drone-core';
import { searchPlugin } from '../src/plugins/search.js';
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

describe('search plugin — text', () => {
  it('returns an empty result (not an error) when nothing matches in an existing dir', async () => {
    const { registration, tools } = captureRegistration();
    await searchPlugin.register(registration);
    const text = tools.get('text');
    expect(text).toBeDefined();

    // Create a fresh empty dir so ripgrep has a valid path with no matches.
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

  it('returns placeholder message when mode="semantic"', async () => {
    const { registration, tools } = captureRegistration();
    await searchPlugin.register(registration);
    const text = tools.get('text');
    expect(text).toBeDefined();
    const result = JSON.parse(
      await text!({ pattern: 'foo', mode: 'semantic' })
    );
    expect(result.note).toMatch(/not yet implemented/i);
  });
});

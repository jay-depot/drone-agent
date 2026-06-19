import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import {
  createDefaultAgentConfig,
  type DronePluginRegistration,
} from 'drone-core';
import { filePlugin, __testing } from '../src/plugins/file.js';
import { silentLogger } from './helpers.js';

const { enhanceFsError } = __testing;

function captureRegistration(): {
  registration: DronePluginRegistration;
  tools: Map<string, (input: Record<string, unknown>) => Promise<string>>;
  helpText: string[];
} {
  const tools = new Map<string, (input: Record<string, unknown>) => Promise<string>>();
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
    registerWorkflow: () => {},
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
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
    const out = enhanceFsError('file.list', '/drone', enoent());
    expect(out.message).toContain('file.list');
    expect(out.message).toContain('not found');
    expect(out.message).toContain('/drone');
    expect(out.message).not.toContain('scandir');
  });

  it('rewrites EACCES to a permission-denied message', () => {
    const out = enhanceFsError('file.read', '/etc/shadow', eacces());
    expect(out.message).toContain('permission denied');
    expect(out.message).toContain('/etc/shadow');
  });

  it('hints to use file.list for EISDIR on read', () => {
    const out = enhanceFsError('file.read', '/home', eisdir());
    expect(out.message).toContain('directory');
    expect(out.message).toContain('file.list');
  });

  it('hints for ENOTDIR on list', () => {
    const out = enhanceFsError('file.list', '/not/a/real/dir', enotdir());
    expect(out.message).toContain('not a directory');
  });

  it('falls back to a generic message for unknown error codes', () => {
    const e: NodeJS.ErrnoException = new Error('something blew up');
    e.code = 'EWHOKNOWS';
    const out = enhanceFsError('file.write', '/tmp/x', e);
    expect(out.message).toContain('file.write');
    expect(out.message).toContain('something blew up');
  });

  it('handles non-Error inputs gracefully', () => {
    const out = enhanceFsError('file.read', '/x', 'a string error');
    expect(out.message).toContain('file.read');
    expect(out.message).toContain('a string error');
  });
});

describe('file plugin — error surfacing', () => {
  it('surfaces ENOENT from file.list as a clear tool error', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const list = tools.get('list');
    expect(list).toBeDefined();

    await expect(list!({ path: '/definitely/not/a/real/path' })).rejects.toThrow(
      /file\.list.*not found.*\/definitely\/not\/a\/real\/path/
    );
  });

  it('surfaces ENOENT from file.read as a clear tool error', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const read = tools.get('read');
    expect(read).toBeDefined();

    await expect(
      read!({ path: '/no/such/file/abcxyz.txt' })
    ).rejects.toThrow(/file\.read.*not found/);
  });

  it('reads an existing file', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const read = tools.get('read');
    expect(read).toBeDefined();

    const target = path.join(
      tmpdir(),
      `drone-agent-read-${Date.now()}.txt`
    );
    await writeFile(target, 'round-trip content', 'utf-8');
    try {
      const result = JSON.parse(await read!({ path: target }));
      expect(result.content).toBe('round-trip content');
    } finally {
      const { unlink } = await import('node:fs/promises');
      await unlink(target).catch(() => undefined);
    }
  });

  it('surfaces EISDIR from file.read when given a directory', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const read = tools.get('read');
    expect(read).toBeDefined();

    await expect(read!({ path: tmpdir() })).rejects.toThrow(/directory/i);
  });

  it('file.glob reports a missing cwd clearly', async () => {
    const { registration, tools } = captureRegistration();
    await filePlugin.register(registration);
    const glob = tools.get('glob');
    expect(glob).toBeDefined();

    await expect(
      glob!({ pattern: '**/*.ts', cwd: '/definitely/not/a/real/path' })
    ).rejects.toThrow(/file\.glob.*not found/);
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

      const readResult = JSON.parse(
        await read!({ path: target })
      );
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDefaultAgentConfig,
  type DronePluginRegistration,
  type DronePortableContextCapability,
  type DronePortableContextExport,
  type DroneSlashCommandContext,
} from 'drone-core';
import {
  checkpointPlugin,
  defaultCheckpointName,
} from '../src/plugins/checkpoint/index.js';
import {
  checkpointDir,
  deleteCheckpoint,
  listCheckpoints,
  readCheckpoint,
  renameCheckpoint,
  sanitizeName,
  writeCheckpoint,
} from '../src/plugins/checkpoint/store.js';
import { registerPortableContextContributor } from '../src/shared/portable-context-contributor.js';
import { silentLogger } from './helpers.js';

const EXPORT: DronePortableContextExport = {
  version: 1,
  createdAt: '2026-10-11T00:00:00.000Z',
  session: { sourceSessionId: 's', turns: [] },
  tools: [],
  pluginData: {},
};

describe('checkpoint store', () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    dir = await mkdtemp(path.join(tmpdir(), 'drone-checkpoint-'));
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it('writes, reads, lists, renames, and deletes', async () => {
    await writeCheckpoint('alpha', EXPORT);
    expect(await listCheckpoints()).toEqual(['alpha']);
    const read = await readCheckpoint('alpha');
    expect(read.version).toBe(1);
    expect(checkpointDir()).toBe(path.join(dir, '.drone-agent', 'checkpoints'));

    await renameCheckpoint('alpha', 'beta');
    expect(await listCheckpoints()).toEqual(['beta']);

    await deleteCheckpoint('beta');
    expect(await listCheckpoints()).toEqual([]);
  });

  it('rejects path traversal and unsafe names', () => {
    expect(() => sanitizeName('../evil')).toThrow();
    expect(() => sanitizeName('a/b')).toThrow();
    expect(() => sanitizeName('')).toThrow();
    expect(() => sanitizeName('.')).toThrow();
    expect(() => sanitizeName('has space')).toThrow();
    expect(sanitizeName('ok-name_1.2')).toBe('ok-name_1.2');
  });

  it('lists nothing when the dir does not exist', async () => {
    expect(await listCheckpoints()).toEqual([]);
  });
});

type Capture = {
  registration: DronePluginRegistration;
  slash: {
    handler: (ctx: DroneSlashCommandContext) => Promise<boolean>;
  } | null;
  getSlash: () => Capture['slash'];
  startHooks: {
    clear?: (payload?: { sessionId: string }) => Promise<void>;
    shutdown?: () => Promise<void>;
    event?: (event: { kind: string }) => Promise<void>;
  };
  offer: unknown;
  pluginFlags: Record<string, string | true>;
};

function makeCapture(
  capability: DronePortableContextCapability | undefined,
  config: ReturnType<typeof createDefaultAgentConfig>,
  pluginFlags: Record<string, string | true> = {}
): Capture {
  const startHooks: Capture['startHooks'] = {};
  let slash: Capture['slash'] = null;
  let offer: unknown;
  const capture: Capture = {
    startHooks,
    getSlash: () => slash,
    slash,
    offer,
    pluginFlags,
    registration: {} as DronePluginRegistration,
  };
  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => config,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: cmd => {
      slash = cmd as Capture['slash'];
    },
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    emitEvent: () => {},
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: cb => {
        startHooks.event = cb as Capture['startHooks']['event'];
      },
      onSessionClear: cb => {
        startHooks.clear = cb as Capture['startHooks']['clear'];
      },
      onSessionRecycle: () => {},
      onShutdown: cb => {
        startHooks.shutdown = cb;
      },
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: cap => {
      offer = cap;
      capture.offer = cap;
      registration.getCliFlags = () => pluginFlags;
    },
    request: <T>(id: string) =>
      (id === 'portable-context'
        ? capability
        : id === 'runtime'
          ? { getSessionId: () => 'sess-1' }
          : undefined) as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    getCliFlags: () => pluginFlags,
    requestElicitation: () => undefined,
    listPlugins: () => [],
  };
  capture.registration = registration;
  return capture;
}

function makeCapability(): {
  capability: DronePortableContextCapability;
  exports: number;
  imports: DronePortableContextExport[];
} {
  let exports = 0;
  const imports: DronePortableContextExport[] = [];
  const capability: DronePortableContextCapability = {
    registerContributor: () => {},
    unregisterContributor: () => {},
    getContributors: () => [],
    exportContext: async () => {
      exports += 1;
      return EXPORT;
    },
    importContext: async data => {
      imports.push(data);
      return { warnings: [], unregisteredTools: [] };
    },
  };
  return { capability, exports, imports };
}

function makeCtx(args: string[]): {
  ctx: DroneSlashCommandContext;
  logs: string[];
} {
  const logs: string[] = [];
  const ctx = {
    line: `/checkpoint ${args.join(' ')}`,
    args,
    logger: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    },
  } as unknown as DroneSlashCommandContext;
  return { ctx, logs };
}

describe('checkpoint plugin', () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    dir = await mkdtemp(path.join(tmpdir(), 'drone-checkpoint-plugin-'));
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it('default name is a filesystem-safe ISO timestamp', () => {
    expect(defaultCheckpointName()).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  });

  it('create/restore/delete/rename/list behave', async () => {
    const { capability, imports } = makeCapability();
    const capture = makeCapture(capability, createDefaultAgentConfig());
    await checkpointPlugin.register(capture.registration);
    const slash = capture.getSlash();
    if (!slash) throw new Error('no slash command');

    // create with explicit name
    await slash.handler(makeCtx(['create', 'snap1']).ctx);
    expect(await listCheckpoints()).toContain('snap1');

    // restore
    await slash.handler(makeCtx(['restore', 'snap1']).ctx);
    expect(imports).toHaveLength(1);

    // rename
    await slash.handler(makeCtx(['rename', 'snap1', 'snap2']).ctx);
    expect(await listCheckpoints()).toEqual(['snap2']);

    // delete
    await slash.handler(makeCtx(['delete', 'snap2']).ctx);
    expect(await listCheckpoints()).toEqual([]);
  });

  it('create with no name uses a timestamp', async () => {
    const { capability } = makeCapability();
    const capture = makeCapture(capability, createDefaultAgentConfig());
    await checkpointPlugin.register(capture.registration);
    const slash = capture.getSlash();
    if (!slash) throw new Error('no slash command');
    await slash.handler(makeCtx(['create']).ctx);
    const names = await listCheckpoints();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('restore queues while busy; others run immediately', async () => {
    const { capability } = makeCapability();
    const capture = makeCapture(capability, createDefaultAgentConfig());
    await checkpointPlugin.register(capture.registration);
    const slash = capture.getSlash();
    if (!slash) throw new Error('no slash command');
    const behavior = slash as unknown as {
      busyBehavior: (inv: { subcommand: string | undefined }) => boolean;
    };
    expect(typeof behavior.busyBehavior).toBe('function');
    expect(behavior.busyBehavior({ subcommand: 'create' })).toBe(true);
    expect(behavior.busyBehavior({ subcommand: 'list' })).toBe(true);
    expect(behavior.busyBehavior({ subcommand: 'restore' })).toBe(false);
  });

  it('auto-writes auto-end on session clear and auto-round on roundComplete', async () => {
    const config = createDefaultAgentConfig();
    config.checkpoint = { autoOnSessionEnd: true, autoOnRoundComplete: true };
    const { capability } = makeCapability();
    const capture = makeCapture(capability, config);
    await checkpointPlugin.register(capture.registration);

    await capture.startHooks.clear?.({ sessionId: 'sess-1' });
    await capture.startHooks.event?.({ kind: 'roundComplete' });
    await capture.startHooks.event?.({ kind: 'roundComplete' });

    const names = await listCheckpoints();
    expect(names.some(n => n.startsWith('auto-end-sess-1-'))).toBe(true);
    expect(names.some(n => /^auto-round-1-sess-1-/.test(n))).toBe(true);
    expect(names.some(n => /^auto-round-2-sess-1-/.test(n))).toBe(true);
  });

  it('does not auto-write when disabled', async () => {
    const { capability } = makeCapability();
    const capture = makeCapture(capability, createDefaultAgentConfig());
    await checkpointPlugin.register(capture.registration);
    await capture.startHooks.clear?.({ sessionId: 'sess-1' });
    await capture.startHooks.event?.({ kind: 'roundComplete' });
    expect(await listCheckpoints()).toEqual([]);
  });

  it('runStartupRestore restores before the first turn (empty session)', async () => {
    const { capability, imports } = makeCapability();
    const capture = makeCapture(capability, createDefaultAgentConfig(), {
      restore: 'boot',
    });
    await checkpointPlugin.register(capture.registration);
    // Write the checkpoint the startup path will read.
    await writeCheckpoint('boot', EXPORT);

    const cpCap = capture.offer as {
      runStartupRestore: () => Promise<{ ok: boolean; summary: string }>;
    };
    const result = await cpCap.runStartupRestore();
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('boot');
    expect(imports).toHaveLength(1);
  });

  it('runStartupRestore reports a missing checkpoint', async () => {
    const { capability } = makeCapability();
    const capture = makeCapture(capability, createDefaultAgentConfig(), {
      restore: 'nope',
    });
    await checkpointPlugin.register(capture.registration);
    const cpCap = capture.offer as {
      runStartupRestore: () => Promise<{ ok: boolean; summary: string }>;
    };
    const result = await cpCap.runStartupRestore();
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('not found');
  });

  it('writes an atomic json file (no .tmp leftovers)', async () => {
    const { capability } = makeCapability();
    const capture = makeCapture(capability, createDefaultAgentConfig());
    await checkpointPlugin.register(capture.registration);
    const slash = capture.getSlash();
    if (!slash) throw new Error('no slash command');
    await slash.handler(makeCtx(['create', 'atomic']).ctx);
    const raw = await readFile(
      path.join(checkpointDir(), 'atomic.json'),
      'utf8'
    );
    expect(JSON.parse(raw).version).toBe(1);
    const entries = await listCheckpoints();
    expect(entries.some(n => n.includes('tmp'))).toBe(false);
  });
});

describe('registerPortableContextContributor helper', () => {
  it('is a no-op when the capability is unavailable', () => {
    expect(() =>
      registerPortableContextContributor(
        { request: () => undefined } as unknown as DronePluginRegistration,
        { id: 'x', export: () => ({}) }
      )
    ).not.toThrow();
  });

  it('registers when the capability is present', () => {
    const registerContributor = vi.fn();
    registerPortableContextContributor(
      {
        request: (id: string) =>
          id === 'portable-context' ? { registerContributor } : undefined,
      } as unknown as DronePluginRegistration,
      { id: 'x', export: () => ({}) }
    );
    expect(registerContributor).toHaveBeenCalledOnce();
  });
});

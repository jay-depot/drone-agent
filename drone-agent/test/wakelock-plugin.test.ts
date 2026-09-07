import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { wakelockPlugin } from '../src/plugins/wakelock/index.js';
import { createDebugFlagRegistry, createDefaultAgentConfig } from 'drone-core';
import type { DroneAgentConfig } from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';

// Mock child_process spawn so no real inhibitor process is started.
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs/promises readFile (used for /proc/version WSL detection).
const mockReadFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

type ConversationEventHandler = (event: {
  kind: string;
  content?: string;
}) => Promise<void>;

function makeChild() {
  return {
    kill: vi.fn(),
    on: vi.fn(),
  };
}

function makeRegistration(overrides?: {
  wakelockEnabled?: boolean;
  isSubagent?: boolean;
}) {
  let onConversationEvent: ConversationEventHandler | undefined;
  let onShutdown: (() => Promise<void>) | undefined;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const config: DroneAgentConfig = createDefaultAgentConfig();
  if (overrides?.wakelockEnabled !== undefined) {
    config.wakelock = { enabled: overrides.wakelockEnabled };
  }

  const registration = {
    logger,
    getConfig: () => config,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: vi.fn(),
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
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
      onConversationEvent: (cb: ConversationEventHandler) => {
        onConversationEvent = cb;
      },
      onSessionClear: () => {},
      onShutdown: (cb: () => Promise<void>) => {
        onShutdown = cb;
      },
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: (id: string) =>
      id === 'runtime'
        ? {
            isSubagent: overrides?.isSubagent ?? false,
            debugFlags,
          }
        : undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };

  return {
    registration,
    getOnConversationEvent: () => onConversationEvent,
    getOnShutdown: () => onShutdown,
    logger,
  };
}

let debugFlags: ReturnType<typeof createDebugFlagRegistry>;

describe('wakelock plugin', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    debugFlags = createDebugFlagRegistry();
    // Default: non-WSL Linux, so the plugin proceeds past the WSL check.
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockReadFile.mockResolvedValue(
      'Linux version 6.8.0-arch1-1 (linux@archlinux) ...'
    );
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('is not enabled by default', () => {
    expect(wakelockPlugin.metadata.defaultEnabled).toBe(false);
  });

  it('does not spawn in subagent mode', async () => {
    const { registration } = makeRegistration({ isSubagent: true });
    await wakelockPlugin.register(registration as never);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does not spawn when wakelock.enabled is false', async () => {
    const { registration } = makeRegistration({ wakelockEnabled: false });
    await wakelockPlugin.register(registration as never);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns on userMessage and stays idempotent for repeated userMessage', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const { registration, getOnConversationEvent } = makeRegistration();
    await wakelockPlugin.register(registration as never);
    const handler = getOnConversationEvent();
    expect(handler).toBeDefined();

    await handler!({ kind: 'userMessage', content: 'hi' });
    await handler!({ kind: 'userMessage', content: 'again' });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      'systemd-inhibit',
      ['--what=idle:sleep', 'sleep', 'infinity'],
      { stdio: 'ignore' }
    );
  });

  it('releases (kills) on roundComplete', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const { registration, getOnConversationEvent } = makeRegistration();
    await wakelockPlugin.register(registration as never);
    const handler = getOnConversationEvent()!;

    await handler({ kind: 'userMessage', content: 'hi' });
    expect(child.kill).not.toHaveBeenCalled();
    await handler({ kind: 'roundComplete' });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('roundComplete without userMessage is a no-op (no crash)', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const { registration, getOnConversationEvent } = makeRegistration();
    await wakelockPlugin.register(registration as never);
    const handler = getOnConversationEvent()!;

    await handler({ kind: 'roundComplete' });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('does not throw when the inhibitor command is unavailable', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn systemd-inhibit ENOENT');
    });
    const { registration, getOnConversationEvent } = makeRegistration();
    await wakelockPlugin.register(registration as never);
    const handler = getOnConversationEvent()!;

    await expect(
      handler({ kind: 'userMessage', content: 'hi' })
    ).resolves.not.toThrow();
    // No crash, no lock held.
    await handler({ kind: 'roundComplete' });
  });

  it('logs a warning and no-ops under WSL', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockReadFile.mockResolvedValue(
      'Linux version 5.15.0-1-microsoft-standard-WSL2 (WSL) ...'
    );
    const { registration, logger } = makeRegistration();
    await wakelockPlugin.register(registration as never);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('WSL'));
  });

  it('kills a live inhibitor on shutdown', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const { registration, getOnConversationEvent, getOnShutdown } =
      makeRegistration();
    await wakelockPlugin.register(registration as never);
    const handler = getOnConversationEvent()!;
    const shutdown = getOnShutdown()!;

    await handler({ kind: 'userMessage', content: 'hi' });
    expect(child.kill).not.toHaveBeenCalled();
    await shutdown();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('logs acquire/release transitions when the wakelock debug flag is on', async () => {
    debugFlags.enable('wakelock');
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const { registration, logger, getOnConversationEvent } = makeRegistration();
    await wakelockPlugin.register(registration as never);
    const handler = getOnConversationEvent()!;

    await handler({ kind: 'userMessage', content: 'hi' });
    await handler({ kind: 'roundComplete' });
    expect(logger.info).toHaveBeenCalledWith('wakelock acquired');
    expect(logger.info).toHaveBeenCalledWith('wakelock released');
  });

  it('uses caffeinate on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const { registration, getOnConversationEvent } = makeRegistration();
    await wakelockPlugin.register(registration as never);
    const handler = getOnConversationEvent()!;

    await handler({ kind: 'userMessage', content: 'hi' });
    expect(mockSpawn).toHaveBeenCalledWith('caffeinate', ['-i'], {
      stdio: 'ignore',
    });
  });

  it('reads the debug flag through a real engine (no TypeError)', async () => {
    // Regression test for the bug where `_runtime.flags` (a RuntimeFlagRegistry)
    // had no `isEnabled`, so `--debug wakelock` threw a swallowed TypeError on
    // every acquire/release. Wired through the real engine with the debug
    // subsystem enabled, the plugin's info log must fire.
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const consoleInfo = vi.spyOn(console, 'log').mockImplementation(() => {});

    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['wakelock'];
    const debugFlags = createDebugFlagRegistry(['wakelock']);
    const engine = createDronePluginEngine({
      plugins: [wakelockPlugin],
      config,
      debugFlags,
    });
    await engine.initialize();

    await engine.runConversationEventHooks({
      kind: 'userMessage',
      content: 'hi',
    });

    expect(consoleInfo).toHaveBeenCalledWith('[wakelock] wakelock acquired');
    consoleInfo.mockRestore();
  });
});

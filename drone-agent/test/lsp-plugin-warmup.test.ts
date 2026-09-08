import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDefaultAgentConfig,
  type DronePluginRegistration,
} from 'drone-core';
import { lspPlugin, filePathFromToolCall } from '../src/plugins/lsp/plugin.js';
import { createServerManager } from '../src/plugins/lsp/server.js';
import { createCodeActionTool } from '../src/plugins/lsp/tools/editing.js';
import type { DroneLspConfig } from 'drone-core';

function makeLspConfig(
  overrides: Partial<DroneLspConfig> = {}
): DroneLspConfig {
  return {
    enabled: true,
    diagnosticTokenBudget: 500,
    requestTimeoutMs: 5000,
    preferExternal: false,
    autoInstall: false,
    preinstall: false,
    servers: {},
    ...overrides,
  };
}

type HookCapture = {
  onAfterToolCall: Array<
    (payload?: {
      calls: Array<{ name: string; arguments: Record<string, unknown> }>;
    }) => Promise<void>
  >;
};

function silentLogger(warns: string[]) {
  return {
    info: () => {},
    warn: (msg: string) => {
      warns.push(msg);
    },
    error: () => {},
  };
}

function registerWithCapture(config: DroneLspConfig, warns: string[]) {
  const hooks: HookCapture = { onAfterToolCall: [] };
  const registration: DronePluginRegistration = {
    logger: silentLogger(warns),
    getConfig: () => {
      const base = createDefaultAgentConfig();
      base.lsp = config;
      return base;
    },
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerSlashCommand: () => {},
    registerWorkflow: () => {},
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
      onAfterToolCall: cb => {
        hooks.onAfterToolCall.push(cb);
      },
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
  lspPlugin.register(registration);
  return hooks;
}

describe('filePathFromToolCall', () => {
  it('extracts the path from canonical file-plugin tool names', () => {
    expect(filePathFromToolCall('file__read', { path: '/tmp/x.ts' })).toBe(
      '/tmp/x.ts'
    );
    expect(filePathFromToolCall('file__write', { path: '/tmp/x.ts' })).toBe(
      '/tmp/x.ts'
    );
    expect(
      filePathFromToolCall('file__apply_diff', { path: '/tmp/x.ts' })
    ).toBe('/tmp/x.ts');
  });

  it('accepts bare tool names (slash-command passthrough form)', () => {
    expect(filePathFromToolCall('read', { path: '/tmp/x.ts' })).toBe(
      '/tmp/x.ts'
    );
  });

  it('ignores non-path-bearing tools', () => {
    expect(filePathFromToolCall('file__list', { path: '/tmp' })).toBe(
      undefined
    );
    expect(filePathFromToolCall('file__glob', { pattern: '*' })).toBe(
      undefined
    );
    expect(filePathFromToolCall('exec__run', { command: 'ls' })).toBe(
      undefined
    );
  });

  it('ignores missing or empty path arguments', () => {
    expect(filePathFromToolCall('file__read', {})).toBe(undefined);
    expect(filePathFromToolCall('file__read', { path: '' })).toBe(undefined);
    expect(filePathFromToolCall('file__read', { path: '   ' })).toBe(undefined);
    expect(filePathFromToolCall('file__read', { path: 42 })).toBe(undefined);
  });
});

describe('lsp onAfterToolCall file warm-up', () => {
  it('attempts a demand start when a file tool touches a servable file (fire-and-forget)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-warmup-'));
    try {
      const warns: string[] = [];
      const hooks = registerWithCapture(makeLspConfig(), warns);
      expect(hooks.onAfterToolCall).toHaveLength(1);

      await hooks.onAfterToolCall[0]!({
        calls: [
          {
            name: 'file__read',
            arguments: { path: path.join(dir, 'notes.yaml') },
          },
        ],
      });

      // Fire-and-forget: the start attempt runs outside the hook await, so
      // poll for its failure warning (yaml resolves as a known ambient spec;
      // with autoInstall off and nothing on PATH the start fails loudly).
      await vi.waitFor(
        () => {
          expect(
            warns.some(w => /yaml/.test(w) && /unavailable|failed/.test(w))
          ).toBe(true);
        },
        { timeout: 5000, interval: 20 }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('code_action routes through the requireRuntimeForFile chokepoint (demand-starts)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-warmup-'));
    try {
      const warns: string[] = [];
      const manager = createServerManager({
        workspaceRoot: dir,
        lspConfig: makeLspConfig(),
        logger: silentLogger(warns),
      });
      await manager.initialize();

      const tool = createCodeActionTool(manager);

      // No runtime for .yaml and the ambient server cannot start (no binary,
      // autoInstall off) — the tool-facing error must be unchanged...
      await expect(
        tool.execute({ filePath: path.join(dir, 'notes.yaml') })
      ).rejects.toThrow(/No connected LSP server is available/);

      // ...but the chokepoint must have attempted the demand start first
      // (pre-change: findRuntimeForFile + immediate throw, no such log).
      await vi.waitFor(
        () => {
          expect(warns.some(w => /lsp demand start failed/.test(w))).toBe(true);
        },
        { timeout: 5000, interval: 20 }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not attempt starts for non-file tools', async () => {
    const warns: string[] = [];
    const hooks = registerWithCapture(makeLspConfig(), warns);

    await hooks.onAfterToolCall[0]!({
      calls: [{ name: 'exec__run', arguments: { command: 'ls' } }],
    });

    // Let the event loop drain any (incorrectly) scheduled work.
    await new Promise(resolve => setImmediate(resolve));
    expect(warns).toHaveLength(0);
  });

  it('does not attempt starts when lsp is disabled', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-warmup-'));
    try {
      const warns: string[] = [];
      const hooks = registerWithCapture(
        makeLspConfig({ enabled: false }),
        warns
      );

      await hooks.onAfterToolCall[0]!({
        calls: [
          {
            name: 'file__read',
            arguments: { path: path.join(dir, 'notes.yaml') },
          },
        ],
      });

      await new Promise(resolve => setImmediate(resolve));
      expect(warns).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

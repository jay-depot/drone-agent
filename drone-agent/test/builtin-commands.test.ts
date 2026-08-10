/**
 * Tests for built-in slash commands (/tools filtering).
 *
 * Covers:
 *   - /tools shows the filtered set (via persona capability)
 *   - /tools --all shows the full unfiltered set
 *   - /tools with no persona active filters out defaultHidden tools
 */

import { describe, expect, it } from 'vitest';
import { BUILT_IN_SLASH_COMMANDS } from '../src/runtime/builtin-commands.js';
import {
  createDebugFlagRegistry,
  type DroneSlashCommandContext,
  type DroneToolDescriptor,
} from 'drone-core';

/**
 * Collect the logger.info calls into an array so we can assert on them.
 */
function makeTestLogger(): {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  messages: string[];
} {
  const messages: string[] = [];
  return {
    info: (msg: string) => {
      messages.push(msg);
    },
    warn: () => {},
    error: () => {},
    messages,
  };
}

const allTools: DroneToolDescriptor[] = [
  { name: 'file__read', description: 'Read a file' },
  { name: 'file__write', description: 'Write a file' },
  { name: 'file__glob', description: 'Glob files' },
  { name: 'exec__run', description: 'Run a command' },
  { name: 'git__status', description: 'Git status' },
];

// A persona that only allows file__read and file__write
function makeFilteringPersonaCap(): {
  getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
} {
  return {
    getFilteredTools: (tools: DroneToolDescriptor[]) =>
      tools.filter(t => t.name === 'file__read' || t.name === 'file__write'),
  };
}

describe('/tools built-in command', () => {
  const toolsCmd = BUILT_IN_SLASH_COMMANDS.find(c => c.command === '/tools');
  if (!toolsCmd) {
    throw new Error('/tools command not found in BUILT_IN_SLASH_COMMANDS');
  }

  it('shows all tools when --all is passed', async () => {
    const logger = makeTestLogger();
    const ctx: DroneSlashCommandContext = {
      line: '/tools --all',
      args: ['--all'],
      logger,
      engine: {
        executeTool: async () => 'ok',
        runHooks: async () => {},
        getCapability: <T>() => makeFilteringPersonaCap() as T,
        listTools: () => allTools,
        listAllTools: () => allTools,
        getRegisteredToolCount: () => allTools.length,
      },
    };

    const result = await toolsCmd.handler(ctx);
    expect(result).toBe(true);
    expect(logger.messages.length).toBe(1);
    expect(logger.messages[0]).toContain('All registered tools (5):');
    expect(logger.messages[0]).toContain('file__read');
    expect(logger.messages[0]).toContain('exec__run');
  });

  it('shows only filtered tools when no --all flag (with persona)', async () => {
    const logger = makeTestLogger();
    const ctx: DroneSlashCommandContext = {
      line: '/tools',
      args: [],
      logger,
      engine: {
        executeTool: async () => 'ok',
        runHooks: async () => {},
        getCapability: <T>() => makeFilteringPersonaCap() as T,
        listTools: () => allTools,
        getRegisteredToolCount: () => allTools.length,
      },
    };

    const result = await toolsCmd.handler(ctx);
    expect(result).toBe(true);
    expect(logger.messages.length).toBe(1);
    expect(logger.messages[0]).toContain('Available tools (2/5):');
    expect(logger.messages[0]).toContain('file__read');
    expect(logger.messages[0]).toContain('file__write');
    expect(logger.messages[0]).not.toContain('exec__run');
    expect(logger.messages[0]).not.toContain('file__glob');
    expect(logger.messages[0]).not.toContain('git__status');
  });

  it('shows only non-defaultHidden tools when no persona is active', async () => {
    const allToolsWithHidden = [
      ...allTools,
      {
        name: 'admin__tool',
        description: 'Hidden admin tool',
        defaultHidden: true,
      },
      {
        name: 'internal__tool',
        description: 'Internal tool',
        defaultHidden: true,
      },
    ];
    const logger = makeTestLogger();
    const ctx: DroneSlashCommandContext = {
      line: '/tools',
      args: [],
      logger,
      engine: {
        executeTool: async () => 'ok',
        runHooks: async () => {},
        getCapability: <T>() => undefined as T,
        listTools: () => allToolsWithHidden,
        getRegisteredToolCount: () => allToolsWithHidden.length,
      },
    };

    const result = await toolsCmd.handler(ctx);
    expect(result).toBe(true);
    expect(logger.messages.length).toBe(1);
    expect(logger.messages[0]).toContain('Available tools (5/7):');
    expect(logger.messages[0]).not.toContain('admin__tool');
    expect(logger.messages[0]).not.toContain('internal__tool');
  });

  it('shows all tools including hidden ones with --all when no persona is active', async () => {
    const allToolsWithHidden = [
      ...allTools,
      {
        name: 'admin__tool',
        description: 'Hidden admin tool',
        defaultHidden: true,
      },
      {
        name: 'internal__tool',
        description: 'Internal tool',
        defaultHidden: true,
      },
    ];
    const logger = makeTestLogger();
    const ctx: DroneSlashCommandContext = {
      line: '/tools --all',
      args: ['--all'],
      logger,
      engine: {
        executeTool: async () => 'ok',
        runHooks: async () => {},
        getCapability: <T>() => undefined as T,
        listTools: () => allToolsWithHidden,
        listAllTools: () => allToolsWithHidden,
        getRegisteredToolCount: () => allToolsWithHidden.length,
      },
    };

    const result = await toolsCmd.handler(ctx);
    expect(result).toBe(true);
    expect(logger.messages.length).toBe(1);
    expect(logger.messages[0]).toContain('All registered tools (7):');
    expect(logger.messages[0]).toContain('admin__tool');
    expect(logger.messages[0]).toContain('internal__tool');
  });
});

describe('/debug built-in command', () => {
  const debugCmd = BUILT_IN_SLASH_COMMANDS.find(c => c.command === '/debug');
  if (!debugCmd) {
    throw new Error('/debug command not found in BUILT_IN_SLASH_COMMANDS');
  }

  it('enables and disables a debug subsystem via the shared registry', async () => {
    const logger = makeTestLogger();
    const debugFlags = createDebugFlagRegistry();
    const ctx: DroneSlashCommandContext = {
      line: '/debug enable tools',
      args: ['enable', 'tools'],
      logger,
      engine: {
        executeTool: async () => 'ok',
        runHooks: async () => {},
        getCapability: <T>() => undefined as T,
      },
      conversation: {
        getModel: () => 'fake',
        setModel: () => {},
        getReasoningLevel: () => undefined,
        setReasoningLevel: () => {},
        sendUserMessage: async () => '',
        getDebugSubsystems: () => debugFlags.list(),
        enableDebugSubsystem: name => debugFlags.enable(name),
        disableDebugSubsystem: name => debugFlags.disable(name),
      },
    };

    const result = await debugCmd.handler(ctx);
    expect(result).toBe(true);
    expect(debugFlags.isEnabled('tools')).toBe(true);
    expect(logger.messages).toContain('Debug subsystem "tools" enabled.');

    // Disable it
    ctx.line = '/debug disable tools';
    ctx.args = ['disable', 'tools'];
    await debugCmd.handler(ctx);
    expect(debugFlags.isEnabled('tools')).toBe(false);
    expect(logger.messages).toContain('Debug subsystem "tools" disabled.');
  });
});

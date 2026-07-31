/**
 * Built-in slash command definitions for the drone-agent engine.
 *
 * These are registered via `registerBuiltinSlashCommand()` during engine
 * initialization, before plugins load. Plugin commands take precedence
 * over built-in commands, allowing plugins to override them.
 */

import {
  type DroneSlashCommand,
  type DroneSlashCommandContext,
  type DroneToolDescriptor,
} from 'drone-core';

// ── /exit, /quit ─────────────────────────────────────────────────────

const exitCommand: DroneSlashCommand = {
  command: '/exit',
  description: 'Exit the application',
  handler: async (ctx: DroneSlashCommandContext) => {
    if (ctx.exit) {
      ctx.exit();
      return true;
    }
    ctx.logger.error('/exit: no exit callback available');
    return false;
  },
};

const quitCommand: DroneSlashCommand = {
  command: '/quit',
  description: 'Exit the application',
  handler: async (ctx: DroneSlashCommandContext) => {
    if (ctx.exit) {
      ctx.exit();
      return true;
    }
    ctx.logger.error('/quit: no exit callback available');
    return false;
  },
};

// ── /help ────────────────────────────────────────────────────────────

const helpCommand: DroneSlashCommand = {
  command: '/help',
  description: 'Show this help',
  handler: async (ctx: DroneSlashCommandContext) => {
    // If the host provides a printHelp function, use it.
    if (ctx.printHelp) {
      ctx.printHelp();
      return true;
    }
    // Fallback: list commands via logger.
    const commands = ctx.engine.getSlashCommands?.() ?? [];
    const lines: string[] = ['Available slash commands:'];
    for (const cmd of commands) {
      lines.push(`  ${cmd.command.padEnd(20)} ${cmd.description}`);
    }
    ctx.logger.info(lines.join('\n'));
    return true;
  },
};

// ── /clear ────────────────────────────────────────────────────────────

const clearCommand: DroneSlashCommand = {
  command: '/clear',
  description: 'Clear the session',
  handler: async (ctx: DroneSlashCommandContext) => {
    // Run onSessionClear hooks first.
    await ctx.engine.runHooks('onSessionClear');
    // Then clear the conversation session.
    if (ctx.conversation?.clearSession) {
      ctx.conversation.clearSession();
      ctx.logger.info('Session cleared.');
      return true;
    }
    ctx.logger.error('/clear: no clearSession callback available');
    return false;
  },
};

// ── /plugins ─────────────────────────────────────────────────────────

const pluginsCommand: DroneSlashCommand = {
  command: '/plugins',
  description: 'List enabled plugins',
  handler: async (ctx: DroneSlashCommandContext) => {
    const plugins = ctx.engine.listPlugins?.() ?? [];
    const lines = plugins
      .map(p => {
        const state = p.enabled ? '[enabled]' : '[disabled]';
        return `  - ${p.id} (${p.name}) ${state}`;
      })
      .join('\n');
    ctx.logger.info(`Plugins:\n${lines}`);
    return true;
  },
};

// ── /tools ────────────────────────────────────────────────────────────

const toolsCommand: DroneSlashCommand = {
  command: '/tools',
  description: 'List registered tools (/tools --all for full list)',
  handler: async (ctx: DroneSlashCommandContext) => {
    const allTools = ctx.engine.listTools?.() ?? [];
    const showAll = ctx.args.includes('--all');

    let tools: DroneToolDescriptor[];
    if (showAll) {
      tools = allTools;
    } else {
      const personaCap = ctx.engine.getCapability<{
        getFilteredTools: (
          tools: DroneToolDescriptor[]
        ) => DroneToolDescriptor[];
      }>('persona');
      tools = personaCap
        ? personaCap.getFilteredTools(allTools)
        : allTools.filter(t => !t.defaultHidden);
    }

    const lines = showAll
      ? [`All registered tools (${tools.length}):`]
      : [`Available tools (${tools.length}/${allTools.length}):`];
    for (const tool of tools) {
      lines.push(`  ${tool.name}`);
      lines.push(`    ${tool.description}`);
    }
    ctx.logger.info(lines.join('\n'));
    return true;
  },
};

// ── /systemprompt ─────────────────────────────────────────────────────

const systemPromptCommand: DroneSlashCommand = {
  command: '/systemprompt',
  description: 'Show the current system prompt',
  handler: async (ctx: DroneSlashCommandContext) => {
    const fragments = (await ctx.engine.renderPromptFragments?.()) ?? [];
    const config = ctx.engine.getConfig?.();
    const lines: string[] = [
      'System Prompt:',
      '────────────────────────────────────────',
      config?.systemPrompt ?? '(not available)',
    ];
    if (fragments.length > 0) {
      lines.push('────────────────────────────────────────');
      lines.push('Prompt Fragments:');
      for (const fragment of fragments) {
        lines.push('────────────────────────────────────────');
        lines.push(fragment);
      }
    }
    ctx.logger.info(lines.join('\n'));
    return true;
  },
};

// ── /tool ─────────────────────────────────────────────────────────────

function tryParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const toolCommand: DroneSlashCommand = {
  command: '/tool',
  description: 'Run a tool directly: /tool <name> [<json-args>]',
  handler: async (ctx: DroneSlashCommandContext) => {
    const rest = ctx.line.slice('/tool '.length).trim();
    const firstSpace = rest.indexOf(' ');
    const toolName = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
    const rawJson = firstSpace === -1 ? '{}' : rest.slice(firstSpace + 1);
    const parsed = tryParseJson(rawJson);
    if (parsed === undefined) {
      ctx.logger.error(`Invalid JSON: ${rawJson}`);
      return true;
    }
    try {
      await ctx.engine.runHooks('onBeforePrompt');
      const result = await ctx.engine.executeTool(toolName, parsed);
      ctx.logger.info(result);
      await ctx.engine.runHooks('onAfterToolCall');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(`Error: ${msg}`);
    }
    return true;
  },
};

// ── /exec ─────────────────────────────────────────────────────────────

const execCommand: DroneSlashCommand = {
  command: '/exec',
  description: 'Run a shell command: /exec <command>',
  handler: async (ctx: DroneSlashCommandContext) => {
    const command = ctx.line.slice('/exec '.length).trim();
    if (!command) {
      ctx.logger.error('Usage: /exec <command>');
      return true;
    }
    try {
      await ctx.engine.runHooks('onBeforePrompt');
      const result = await ctx.engine.executeTool('exec__run', {
        command,
        cwd: process.cwd(),
      });
      ctx.logger.info(result);
      await ctx.engine.runHooks('onAfterToolCall');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(`Error: ${msg}`);
    }
    return true;
  },
};

// ── /debug ─────────────────────────────────────────────────────────────

const debugCommand: DroneSlashCommand = {
  command: '/debug',
  description:
    'Enable or disable a debug subsystem: /debug enable|disable <name>',
  handler: async (ctx: DroneSlashCommandContext) => {
    if (!ctx.conversation) {
      ctx.logger.warn(
        'Conversation service not available — cannot manage debug subsystems.'
      );
      return true;
    }

    const args = ctx.args;

    // No arguments: show current state + usage
    if (args.length === 0) {
      const subsystems = ctx.conversation.getDebugSubsystems();
      const state =
        subsystems.length > 0
          ? `Debug subsystems: ${subsystems.join(', ')}`
          : 'No debug subsystems enabled.';
      ctx.logger.info(
        `${state}\nUsage: /debug enable|disable <subsystem>\nExample: /debug enable llm`
      );
      return true;
    }

    // Wrong number of arguments
    if (args.length !== 2) {
      ctx.logger.info(
        'Usage: /debug enable|disable <subsystem>\nExample: /debug enable llm'
      );
      return true;
    }

    const [action, subsystem] = args;

    if (action === 'enable') {
      ctx.conversation.enableDebugSubsystem(subsystem);
      ctx.logger.info(`Debug subsystem "${subsystem}" enabled.`);
    } else if (action === 'disable') {
      ctx.conversation.disableDebugSubsystem(subsystem);
      ctx.logger.info(`Debug subsystem "${subsystem}" disabled.`);
    } else {
      ctx.logger.warn(`Invalid action "${action}". Use "enable" or "disable".`);
    }

    return true;
  },
};

// ── All built-in commands ─────────────────────────────────────────────

export const BUILT_IN_SLASH_COMMANDS: DroneSlashCommand[] = [
  exitCommand,
  quitCommand,
  helpCommand,
  clearCommand,
  pluginsCommand,
  toolsCommand,
  systemPromptCommand,
  toolCommand,
  execCommand,
  debugCommand,
];

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
  description: 'List mounted tools (/tools --all for all registered tools)',
  handler: async (ctx: DroneSlashCommandContext) => {
    const showAll = ctx.args.includes('--all');

    let tools: DroneToolDescriptor[];
    if (showAll) {
      tools = ctx.engine.listAllTools?.() ?? [];
    } else {
      const mountedTools = ctx.engine.listTools?.() ?? [];
      const personaCap = ctx.engine.getCapability<{
        getFilteredTools: (
          tools: DroneToolDescriptor[]
        ) => DroneToolDescriptor[];
      }>('persona');
      tools = personaCap
        ? personaCap.getFilteredTools(mountedTools)
        : mountedTools.filter(t => !t.defaultHidden);
    }

    const totalCount = ctx.engine.getRegisteredToolCount?.() ?? 0;
    const lines = showAll
      ? [`All registered tools (${tools.length}):`]
      : [`Available tools (${tools.length}/${totalCount}):`];
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
    const systemMessages = (await ctx.engine.buildSystemMessages?.()) ?? [];
    const lines: string[] = ['System Messages:'];
    for (const msg of systemMessages) {
      lines.push('────────────────────────────────────────');
      lines.push(msg.content);
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
  description:
    'Tool utilities: /tool mount <name>, /tool unmount <name>|--all, or run a tool directly: /tool <name> [<json-args>]',
  handler: async (ctx: DroneSlashCommandContext) => {
    const sub = ctx.args[0];

    // ── /tool mount <canonicalName> ──
    if (sub === 'mount') {
      const name = ctx.args[1];
      if (!name || ctx.args.length > 2) {
        ctx.logger.error(
          'Usage: /tool mount <canonicalName>  e.g. /tool mount file__read'
        );
        return true;
      }
      if (!ctx.engine.mountTool) {
        ctx.logger.error('/tool mount: no mountTool callback available');
        return true;
      }
      const def = ctx.engine.mountTool(name);
      if (!def) {
        ctx.logger.error(`Unknown or already mounted tool: ${name}`);
      } else {
        ctx.logger.info(`Mounted ${name}.`);
      }
      return true;
    }

    // ── /tool unmount <canonicalName> | --all ──
    if (sub === 'unmount') {
      if (!ctx.engine.unmountTool || !ctx.engine.listMountedTools) {
        ctx.logger.error('/tool unmount: no unmount callback available');
        return true;
      }
      if (ctx.args[1] === '--all') {
        const targets = ctx.engine
          .listMountedTools()
          .filter(t => !t.name.startsWith('runtime__'));
        if (targets.length === 0) {
          ctx.logger.info('No mounted tools to unmount.');
          return true;
        }
        for (const t of targets) {
          ctx.engine.unmountTool(t.name);
        }
        ctx.logger.info(
          `Unmounted ${targets.length} tool(s): ${targets
            .map(t => t.name)
            .join(', ')}`
        );
        return true;
      }
      const name = ctx.args[1];
      if (!name || ctx.args.length > 2) {
        ctx.logger.error(
          'Usage: /tool unmount <canonicalName>  or  /tool unmount --all'
        );
        return true;
      }
      ctx.engine.unmountTool(name);
      ctx.logger.info(`Unmounted ${name}.`);
      return true;
    }

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

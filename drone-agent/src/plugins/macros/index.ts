import type {
  DroneMacroDefinition,
  DronePlugin,
  DroneSlashCommandContext,
} from 'drone-core';
import { loadMacros } from './loader.js';
import { substituteMacroArgs } from './parser.js';

export type MacrosCapability = {
  getMacros: () => DroneMacroDefinition[];
  reloadMacros: () => Promise<void>;
};

export const macrosPlugin: DronePlugin = {
  metadata: {
    id: 'macros',
    name: 'Macros',
    version: '0.1.0',
    description:
      'Custom slash commands defined in .macro files. Off by default.',
    defaultEnabled: false,
  },
  register: async registration => {
    const projectDir = process.cwd();
    let macros = new Map<string, DroneMacroDefinition>();

    // Track which macro command names we've registered so we can detect
    // conflicts with other plugins' slash commands.
    const registeredCommands = new Set<string>();

    async function reloadAndRegister(): Promise<void> {
      macros = await loadMacros(projectDir, registration.logger);

      if (macros.size === 0) {
        registration.logger.info('no .macro files found');
        return;
      }

      registration.logger.info(
        `loaded ${macros.size} macro(s): ${Array.from(macros.keys()).join(', ')}`
      );

      for (const [command, macro] of macros) {
        // Check for duplicate registration within the macros plugin.
        if (registeredCommands.has(command)) {
          registration.logger.warn(
            `Duplicate macro command ${command} (from ${macro.filePath}) — skipping.`
          );
          continue;
        }

        registeredCommands.add(command);

        registration.registerSlashCommand({
          command,
          description: macro.description || `Custom macro (${macro.filePath})`,
          handler: async (ctx: DroneSlashCommandContext) => {
            await executeMacro(macro, ctx);
            return true;
          },
        });
      }
    }

    /**
     * Build a usage hint string for a macro, showing its command and expected arguments.
     */
    function formatMacroUsage(macro: DroneMacroDefinition): string {
      const parts: string[] = [macro.command];
      for (const arg of macro.argSpec) {
        if (arg.required) {
          parts.push(`<arg${arg.position}>`);
        } else {
          parts.push(`[arg${arg.position}]`);
        }
      }
      if (macro.hasCatchAll) {
        if (macro.catchAllOptional) {
          parts.push('[args...]');
        } else {
          parts.push('<args...>');
        }
      }
      return parts.join(' ');
    }

    async function executeMacro(
      macro: DroneMacroDefinition,
      ctx: DroneSlashCommandContext
    ): Promise<void> {
      for (const step of macro.steps) {
        try {
          if (step.kind === 'slashCommand') {
            const substituted = substituteMacroArgs(step.line, ctx.args, macro);
            const handled = await ctx.engine.dispatchSlashCommand?.(
              substituted,
              ctx
            );
            if (!handled) {
              ctx.logger.warn(`Macro step not handled: ${substituted}`);
            }
          } else {
            // chatPrompt step
            const substituted = substituteMacroArgs(step.text, ctx.args, macro);
            ctx.logger.info(substituted);
            if (ctx.conversation) {
              await ctx.engine.runHooks?.('onBeforePrompt');
              const reply = await ctx.conversation.sendUserMessage(substituted);
              if (reply.length > 0) {
                ctx.logger.info(reply);
              }
              await ctx.engine.runHooks?.('onAfterToolCall');
            } else {
              // Fallback: append as user message if no conversation available.
              ctx.sessionManager?.appendUserMessage(substituted);
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const usage = formatMacroUsage(macro);
          ctx.logger.warn(
            `Macro "${macro.command}" failed: ${message}\n` +
              `Usage: ${usage}\n` +
              `Description: ${macro.description || '(no description)'}`
          );
          // Stop executing further steps for this macro invocation.
          return;
        }
      }
    }

    // Capability offered to other plugins (and the /macro slash command).
    const capability: MacrosCapability = {
      getMacros: () => Array.from(macros.values()),
      reloadMacros: async () => {
        await reloadAndRegister();
        registration.logger.info('macros reloaded');
      },
    };

    registration.offer(capability);

    // -----------------------------------------------------------------------
    // onPluginsLoaded — load macros and register slash commands
    // -----------------------------------------------------------------------
    registration.hooks.onPluginsLoaded(async () => {
      await reloadAndRegister();
    });

    // -----------------------------------------------------------------------
    // /macro slash command — list, reload, show
    // -----------------------------------------------------------------------
    registration.registerSlashCommand({
      command: '/macro',
      description: 'Manage macros: list, reload, show.',
      handler: async ctx => {
        const subcommand = ctx.args[0] ?? '';

        if (subcommand === 'list') {
          const all = Array.from(macros.values());
          if (all.length === 0) {
            ctx.logger.info('No macros loaded.');
            return true;
          }
          const lines = all.map(
            m =>
              `  ${m.command} — ${m.description || '(no description)'} (${m.steps.length} step(s))`
          );
          ctx.logger.info(`Macros:\n${lines.join('\n')}`);
          return true;
        }

        if (subcommand === 'reload') {
          await reloadAndRegister();
          ctx.logger.info(`Reloaded ${macros.size} macro(s).`);
          return true;
        }

        if (subcommand === 'show') {
          const name = ctx.args.slice(1).join(' ');
          if (!name) {
            ctx.logger.warn('Usage: /macro show <command>');
            return true;
          }
          const macro = macros.get(name.startsWith('/') ? name : '/' + name);
          if (!macro) {
            ctx.logger.warn(`Unknown macro: ${name}`);
            return true;
          }
          const lines = [
            `Macro: ${macro.command}`,
            `  Description: ${macro.description || '(none)'}`,
            `  File: ${macro.filePath}`,
            `  Steps:`,
          ];
          for (const step of macro.steps) {
            if (step.kind === 'slashCommand') {
              lines.push(`    / ${step.line}`);
            } else {
              lines.push(`    > ${step.text}`);
            }
          }
          ctx.logger.info(lines.join('\n'));
          return true;
        }

        ctx.logger.warn(
          'Unknown /macro command. Try: /macro list, /macro reload, /macro show <command>'
        );
        return true;
      },
    });

    // Help snippets.
    registration.registerHelp('/macro list          List loaded macros');
    registration.registerHelp('/macro reload        Re-scan macro directories');
    registration.registerHelp('/macro show <name>   Show macro definition');
  },
};

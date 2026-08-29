import type { DronePlugin, DroneSlashCommandContext } from 'drone-core';
import type { DroneMacroDefinition } from './types.js';
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
    version: '1.0.0',
    description: 'Custom slash commands from .macro files',
    defaultEnabled: true,
  },
  register: async registration => {
    const { logger, registerSlashCommand, offer } = registration;
    const projectDir = process.cwd();

    let macros = new Map<string, DroneMacroDefinition>();

    async function reloadMacros(): Promise<void> {
      macros = await loadMacros(projectDir, logger);
    }

    await reloadMacros();

    function formatMacroUsage(macro: DroneMacroDefinition): string {
      let usage = `/${macro.command}`;
      for (const spec of macro.argSpec) {
        usage += spec.required
          ? ` <$${spec.position}>`
          : ` [$${spec.position}?]`;
      }
      if (macro.hasCatchAll) {
        usage += macro.catchAllOptional ? ' [$$...]' : ' <$$...>';
      }
      return usage;
    }

    function formatMacroHelp(macro: DroneMacroDefinition): string {
      const usage = formatMacroUsage(macro);
      return `  ${usage.padEnd(40)}${macro.description}`;
    }

    // Register a slash command for each loaded macro.
    function registerMacroCommands(): void {
      for (const [command, macro] of macros) {
        registerSlashCommand({
          command,
          description: macro.description,
          handler: async (ctx: DroneSlashCommandContext) => {
            const { args, logger: ctxLogger } = ctx;
            try {
              // Process each step in order.
              for (const step of macro.steps) {
                if (step.kind === 'slashCommand') {
                  const substituted = substituteMacroArgs(
                    step.line,
                    args,
                    macro
                  );
                  // Dispatch the substituted slash command through the engine.
                  if (ctx.engine.dispatchSlashCommand) {
                    const handled = await ctx.engine.dispatchSlashCommand(
                      substituted,
                      ctx
                    );
                    if (!handled) {
                      ctxLogger.warn(`Macro step not handled: ${substituted}`);
                    }
                  } else {
                    ctxLogger.warn(
                      'Macro engine does not support dispatchSlashCommand'
                    );
                  }
                } else {
                  // Chat prompt: send to conversation and wait for response.
                  const substituted = substituteMacroArgs(
                    step.text,
                    args,
                    macro
                  );
                  ctxLogger.info(substituted);
                  if (ctx.conversation?.sendUserMessage) {
                    await ctx.engine.runHooks?.('onBeforePrompt');
                    await ctx.conversation.sendUserMessage(substituted);
                    await ctx.engine.runHooks?.('onAfterToolCall');
                  } else {
                    // Fallback: append as user message if no conversation available.
                    ctx.sessionManager?.appendUserMessage(substituted);
                  }
                }
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const usage = formatMacroUsage(macro);
              ctxLogger.warn(
                `Macro "${command}" error: ${message}\nUsage: ${usage}`
              );
            }
            return true;
          },
        });
      }
    }

    registerMacroCommands();

    // Offer the macros capability so other plugins can list/reload macros.
    const capability: MacrosCapability = {
      getMacros: () => [...macros.values()],
      reloadMacros,
    };
    offer<MacrosCapability>(capability);

    // Register help for all loaded macros.
    registration.registerHelp('/macro list           List available macros');
    registration.registerHelp('/macro show <name>    Show a macro definition');
    registration.registerHelp(
      '/macro reload         Reload .macro files from disk'
    );

    // Register the /macro management slash command.
    registerSlashCommand({
      command: '/macro',
      description: 'Manage macros: list, show, reload.',
      handler: async ctx => {
        const subcommand = ctx.args[0] ?? '';
        if (subcommand === 'list') {
          const all = [...macros.values()];
          if (all.length === 0) {
            ctx.logger.info('No macros loaded.');
          } else {
            ctx.logger.info(
              `Loaded macros:\n${all.map(m => formatMacroHelp(m)).join('\n')}`
            );
          }
          return true;
        }
        if (subcommand === 'reload') {
          await reloadMacros();
          ctx.logger.info(`Reloaded ${macros.size} macro(s).`);
          return true;
        }
        if (subcommand === 'show') {
          const name = ctx.args.slice(1).join(' ');
          if (!name) {
            ctx.logger.warn('Usage: /macro show <name>');
            return true;
          }
          const macro = macros.get('/' + name);
          if (!macro) {
            ctx.logger.warn(`Unknown macro: ${name}`);
            return true;
          }
          ctx.logger.info(
            `Macro: ${macro.command}\nDescription: ${macro.description}\nSteps: ${macro.steps.length}`
          );
          return true;
        }
        ctx.logger.warn(
          'Unknown macro command. Try: /macro list, /macro show <name>, /macro reload'
        );
        return true;
      },
    });

    // Register a workflow to reload macros.
    registration.registerHelp(
      `\n  Macros:\n${[...macros.values()]
        .map(m => formatMacroHelp(m))
        .join('\n')}`
    );

    // Register a workflow to reload macros.
    registration.registerWorkflow({
      name: 'reload',
      description: 'Reload all .macro files from disk',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      run: async () => {
        await reloadMacros();
        return {
          toolResult: JSON.stringify({ reloaded: true, count: macros.size }),
        };
      },
    });
  },
};

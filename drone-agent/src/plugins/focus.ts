import type { DronePlugin, DroneSlashCommandContext } from 'drone-core';

type FocusState = {
  currentFocus: string | null;
};

export const focusPlugin: DronePlugin = {
  metadata: {
    id: 'focus',
    name: 'Focus',
    version: '0.1.0',
    description:
      'Maintains a session focus that is included in the system prompt.',
    defaultEnabled: false,
  },
  register: async registration => {
    const state: FocusState = {
      currentFocus: null,
    };

    registration.registerPromptFragment({
      key: 'focus-current',
      phase: 'header',
      render: async () => {
        if (!state.currentFocus) {
          return '';
        }
        return `# Current Focus

**Primary Objective:** ${state.currentFocus}

**Strict Adherence:** You are currently in a "focused state." Prioritize all actions toward fulfilling this objective and do not deviate from it until the task is finished or you have been explicitly told to clear your focus. You may only deviate if you encounter a critical blocker that requires immediate resolution to proceed.`;
      },
    });

    // Slash command: /focus
    registration.registerSlashCommand({
      command: '/focus',
      description: 'Session focus management: set, clear, show',
      handler: async (ctx: DroneSlashCommandContext) => {
        const subcommand = ctx.args[0] ?? '';

        // /focus show (default if no subcommand)
        if (subcommand === 'show' || subcommand === '') {
          if (state.currentFocus) {
            ctx.logger.info(`Current focus: ${state.currentFocus}`);
          } else {
            ctx.logger.info('No focus set. Use /focus set <thing> to set one.');
          }
          return true;
        }

        // /focus set
        if (subcommand === 'set') {
          const focus = ctx.args.slice(1).join(' ').trim();

          if (!focus) {
            ctx.logger.info(
              'Usage: /focus set <Current thing to focus on>\nExample: /focus set Fix login bug'
            );
            return true;
          }

          state.currentFocus = focus;
          ctx.logger.info(`Focus set to: ${state.currentFocus}`);
          registration.emitEvent({ kind: 'focusChanged', focus });
          return true;
        }

        // /focus clear
        if (subcommand === 'clear') {
          state.currentFocus = null;
          ctx.logger.info('Focus cleared.');
          registration.emitEvent({ kind: 'focusChanged', focus: null });
          return true;
        }

        // Unknown subcommand - show help
        ctx.logger.info(
          `Usage: /focus <subcommand> [args]
  Subcommands:
    show           Show current focus
    set <focus>    Set the focus
    clear          Clear the focus`
        );
        return true;
      },
    });

    // Help text
    registration.registerHelp('/focus show        Show current focus');
    registration.registerHelp('/focus set <focus> Set the focus');
    registration.registerHelp('/focus clear       Clear the focus');

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('focus plugin ready');
    });

    // Mid-panel widget
    registration.offer({
      id: 'focus',
      label: 'FOCUS',
      getContent: () => {
        if (!state.currentFocus) return [];
        return ['SET'];
      },
    });
  },
};

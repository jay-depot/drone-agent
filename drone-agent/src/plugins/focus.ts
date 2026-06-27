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

Your current focus is: ${state.currentFocus}`;
      },
    });

    registration.registerTool({
      name: 'focus',
      description:
        'Manage session focus. Actions: get, set, clear.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Action: get, set, clear',
            enum: ['get', 'set', 'clear'],
          },
          focus: {
            type: 'string',
            description: 'The thing to focus on (for set action)',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async input => {
        const { action, focus } = input;

        if (action === 'get') {
          return JSON.stringify(
            {
              currentFocus: state.currentFocus,
            },
            null,
            2
          );
        }

        if (action === 'set') {
          if (typeof focus !== 'string' || focus.trim().length === 0) {
            throw new Error('focus set requires a non-empty focus string.');
          }
          state.currentFocus = focus.trim();
          return JSON.stringify(
            {
              action: 'set',
              currentFocus: state.currentFocus,
            },
            null,
            2
          );
        }

        if (action === 'clear') {
          state.currentFocus = null;
          return JSON.stringify(
            {
              action: 'clear',
              currentFocus: null,
            },
            null,
            2
          );
        }

        throw new Error('focus action must be one of: get, set, clear');
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
          return true;
        }

        // /focus clear
        if (subcommand === 'clear') {
          state.currentFocus = null;
          ctx.logger.info('Focus cleared.');
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
  },
};
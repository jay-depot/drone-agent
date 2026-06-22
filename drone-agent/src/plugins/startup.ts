import type { DronePlugin } from 'drone-core';

export const startupPlugin: DronePlugin = {
  metadata: {
    id: 'startup',
    name: 'Startup',
    version: '0.1.0',
    description: 'Bootstraps the local CLI session.',
    required: true,
    defaultEnabled: true,
  },
  register: async registration => {
    registration.registerPromptFragment({
      key: 'startup-banner',
      phase: 'header',
      render: async () => 'drone-agent ready.',
    });

    registration.registerTool({
      name: 'status',
      description: 'Summarize the current bootstrap state.',
      execute: async () => 'Local runtime bootstrapped successfully.',
    });

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('plugins loaded');
    });

    registration.offer({
      startupMessage: 'drone-agent ready. Ctrl+J for multi-line input, Enter to send.',
    });
  },
};

import type { DronePlugin } from 'drone-core';
import os from 'node:os';

function getFormattedDateTime(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
  return formatter.format(now);
}

function getOS(): string {
  const platform = os.platform();
  const release = os.release();
  if (platform === 'darwin') return `macOS ${release}`;
  if (platform === 'win32') return `Windows ${release}`;
  return `${platform} ${release}`;
}

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
    const cwd = process.cwd();
    const homeDir = os.homedir();
    const osInfo = getOS();
    const dateTime = getFormattedDateTime();

    registration.registerPromptFragment({
      key: 'startup-banner',
      phase: 'header',
      render: async () =>
        `Current working directory: ${cwd}\nUser's home directory: ${homeDir}\nOperating system: ${osInfo}\nCurrent date, time and timezone: ${dateTime}`,
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
      startupMessage:
        'drone-agent ready. Ctrl+J for multi-line input, Enter to send.',
    });
  },
};

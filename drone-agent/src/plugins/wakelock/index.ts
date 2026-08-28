import { spawn, type ChildProcess } from 'node:child_process';
import type { DronePlugin } from 'drone-core';

type RuntimeInfo = {
  isSubagent: boolean;
  flags: { isEnabled(name: string): boolean };
};

type Inhibitor = {
  cmd: string;
  args: string[];
};

/**
 * Resolve the platform inhibitor command, or null when this platform is
 * unsupported (no-op). WSL is detected separately because systemd-inhibit
 * runs there but only inhibits the guest, not the Windows host.
 */
async function resolveInhibitor(): Promise<Inhibitor | null> {
  const platform = process.platform;
  if (platform === 'darwin') {
    return { cmd: 'caffeinate', args: ['-i'] };
  }
  if (platform === 'linux') {
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=idle:sleep', 'sleep', 'infinity'],
    };
  }
  return null;
}

async function isWsl(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const { readFile } = await import('node:fs/promises');
    const version = await readFile('/proc/version', 'utf8');
    return /microsoft|WSL/i.test(version);
  } catch {
    return false;
  }
}

export const wakelockPlugin: DronePlugin = {
  metadata: {
    id: 'wakelock',
    name: 'Wakelock',
    version: '0.1.0',
    description:
      'Prevents the host machine from sleeping while the agent is working.',
    defaultEnabled: false,
  },
  register: async registration => {
    const config = registration.getConfig().wakelock;
    const runtime = registration.request<RuntimeInfo>('runtime');
    if (runtime?.isSubagent) return; // subagents never acquire the lock
    if (!config.enabled) return;

    if (await isWsl()) {
      registration.logger.warn(
        'wakelock: WSL detected — systemd-inhibit only inhibits the guest, not the Windows host. Wakelock disabled.'
      );
      return;
    }

    const inhibitor = await resolveInhibitor();
    if (!inhibitor) {
      return; // unsupported platform — silent no-op
    }

    let working = false;
    let child: ChildProcess | null = null;
    const debug = () => runtime?.flags.isEnabled('wakelock') ?? false;

    const acquire = () => {
      if (working || !inhibitor) return; // idempotent
      working = true;
      try {
        child = spawn(inhibitor.cmd, inhibitor.args, { stdio: 'ignore' });
      } catch (err) {
        // Command unavailable (e.g. ENOENT) — never crash the agent.
        working = false;
        if (debug()) {
          const message = err instanceof Error ? err.message : String(err);
          registration.logger.warn(`wakelock unavailable: ${message}`);
        }
        return;
      }
      child.on('error', err => {
        working = false;
        child = null;
        if (debug()) {
          registration.logger.warn(
            `wakelock inhibitor errored: ${err.message}`
          );
        }
      });
      if (debug()) registration.logger.info('wakelock acquired');
    };

    const release = () => {
      if (!working) return;
      working = false;
      if (child) {
        child.kill();
        child = null;
      }
      if (debug()) registration.logger.info('wakelock released');
    };

    registration.hooks.onConversationEvent(async event => {
      if (event.kind === 'userMessage') {
        acquire();
      } else if (event.kind === 'roundComplete') {
        release();
      }
    });

    registration.hooks.onShutdown(async () => {
      if (child) {
        child.kill();
        child = null;
      }
    });

    registration.registerHelp(
      'Wakelock: prevents host sleep while working. Enable via wakelock.enabled or enabling the wakelock plugin.'
    );
  },
};

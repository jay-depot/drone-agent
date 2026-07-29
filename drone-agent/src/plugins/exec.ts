import { isRecord } from '../shared/type-guards.js';
import { spawn } from 'node:child_process';
import type { DronePlugin } from 'drone-core';
import { ExecRunBlock } from '../tui/components/ExecRunBlock.js';

type ExecInput = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

function parseExecInput(input: Record<string, unknown>): ExecInput {
  if (!isRecord(input)) {
    throw new Error('exec__run expected an object input.');
  }

  if (typeof input.command !== 'string' || input.command.trim().length === 0) {
    throw new Error('exec__run requires a non-empty string command.');
  }

  if (input.cwd !== undefined && typeof input.cwd !== 'string') {
    throw new Error('exec__run cwd must be a string when provided.');
  }

  if (
    input.timeoutMs !== undefined &&
    (typeof input.timeoutMs !== 'number' ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs <= 0)
  ) {
    throw new Error(
      'exec__run timeoutMs must be a positive number when provided.'
    );
  }

  return {
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
  };
}

async function runCommand(
  input: ExecInput,
  onProgress?: (chunk: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeoutId = input.timeoutMs
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`Command timed out after ${input.timeoutMs}ms.`));
        }, input.timeoutMs)
      : undefined;

    const clearTimer = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    child.stdout.on('data', chunk => {
      const text = String(chunk);
      stdout += text;
      onProgress?.(text);
    });

    child.stderr.on('data', chunk => {
      const text = String(chunk);
      stderr += text;
      onProgress?.(text);
    });

    child.on('error', error => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      reject(error);
    });

    child.on('close', exitCode => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      resolve(
        JSON.stringify(
          {
            command: input.command,
            cwd: input.cwd,
            exitCode,
            stdout,
            stderr,
          },
          null,
          2
        )
      );
    });
  });
}

export const execPlugin: DronePlugin = {
  metadata: {
    id: 'exec',
    name: 'Exec',
    version: '0.1.0',
    description: 'Executes shell commands on the local machine.',
    defaultEnabled: true,
  },
  register: async registration => {
    registration.registerTool({
      name: 'run',
      description: 'Run a shell command. Returns stdout, stderr, exit code.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory (optional).' },
          timeoutMs: {
            type: 'number',
            description: 'Timeout in milliseconds (optional).',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      execute: async (input, onProgress) =>
        runCommand(parseExecInput(input), onProgress),
      renderComponent: state => ExecRunBlock({ state }),
    });

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('exec tool ready');
    });
  },
};

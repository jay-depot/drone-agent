import type { DroneToolDefinition } from 'drone-core';
import { runGit, resolveCwd } from '../run-git.js';
import { LogBlock } from '../components/LogBlock.js';

export function createLogTool(): DroneToolDefinition {
  return {
    name: 'log',
    description:
      'Recent commits: hash, author, date, message. Optional maxCount and path filter.',
    inputSchema: {
      type: 'object',
      properties: {
        maxCount: { type: 'number', description: 'Max commits. Default 10.' },
        path: { type: 'string', description: 'Restrict to a file (optional).' },
        cwd: {
          type: 'string',
          description: 'Working directory (default: cwd).',
        },
      },
      additionalProperties: false,
    },
    renderComponent: state => LogBlock({ state }),
    execute: async input => {
      const cwd = resolveCwd(input);
      const maxCount =
        typeof input.maxCount === 'number' && Number.isFinite(input.maxCount)
          ? Math.max(1, Math.floor(input.maxCount))
          : 10;

      const args = [
        'log',
        `--max-count=${maxCount}`,
        '--format=%H|||%an|||%ai|||%s',
      ];
      if (typeof input.path === 'string' && input.path.trim().length > 0) {
        args.push('--', input.path.trim());
      }

      const output = await runGit(args, cwd);
      const entries = output
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => {
          const parts = line.split('|||');
          return {
            hash: parts[0] ?? '',
            author: parts[1] ?? '',
            date: parts[2] ?? '',
            message: parts[3] ?? '',
          };
        });

      return JSON.stringify(
        {
          path: typeof input.path === 'string' ? input.path.trim() : undefined,
          entries,
        },
        null,
        2
      );
    },
  };
}

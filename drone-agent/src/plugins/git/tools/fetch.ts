import type { DroneToolDefinition } from 'drone-core';
import { runGit, resolveCwd } from '../run-git.js';
import { FetchPullBlock } from '../components/FetchPullBlock.js';

export function createFetchTool(): DroneToolDefinition {
  return {
    name: 'fetch',
    description:
      'Download objects and refs from a remote (does not merge). Optional remote, all (all remotes), prune (remove stale remote refs).',
    inputSchema: {
      type: 'object',
      properties: {
        remote: {
          type: 'string',
          description: 'Remote name (optional, default origin).',
        },
        all: {
          type: 'boolean',
          description: 'Fetch from all remotes. Default false.',
        },
        prune: {
          type: 'boolean',
          description: 'Remove stale remote-tracking refs. Default false.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (default: cwd).',
        },
      },
      additionalProperties: false,
    },
    renderComponent: state => FetchPullBlock({ state }),
    execute: async input => {
      const cwd = resolveCwd(input);
      const args = ['fetch'];
      if (input.all === true) {
        args.push('--all');
      } else if (
        typeof input.remote === 'string' &&
        input.remote.trim().length > 0
      ) {
        args.push(input.remote.trim());
      }
      if (input.prune === true) {
        args.push('--prune');
      }
      try {
        const output = await runGit(args, cwd);
        return JSON.stringify(
          { command: 'fetch', success: true, explanation: output || undefined },
          null,
          2
        );
      } catch (err) {
        return JSON.stringify(
          {
            command: 'fetch',
            success: false,
            explanation: err instanceof Error ? err.message : String(err),
          },
          null,
          2
        );
      }
    },
  };
}

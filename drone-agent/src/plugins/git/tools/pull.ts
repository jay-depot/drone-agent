import type { DroneToolDefinition } from 'drone-core';
import { runGit, resolveCwd } from '../run-git.js';
import { FetchPullBlock } from '../components/FetchPullBlock.js';

export function createPullTool(): DroneToolDefinition {
  return {
    name: 'pull',
    description:
      'Fetch from a remote and integrate into the current branch. Optional remote, branch, and rebase (use rebase instead of merge).',
    inputSchema: {
      type: 'object',
      properties: {
        remote: {
          type: 'string',
          description: 'Remote name (optional, default origin).',
        },
        branch: {
          type: 'string',
          description: 'Remote branch to pull (optional).',
        },
        rebase: {
          type: 'boolean',
          description: 'Use rebase instead of merge. Default false.',
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
      const args = ['pull'];
      if (input.rebase === true) {
        args.push('--rebase');
      }
      if (typeof input.remote === 'string' && input.remote.trim().length > 0) {
        args.push(input.remote.trim());
        if (
          typeof input.branch === 'string' &&
          input.branch.trim().length > 0
        ) {
          args.push(input.branch.trim());
        }
      }
      try {
        const output = await runGit(args, cwd);
        return JSON.stringify(
          { command: 'pull', success: true, explanation: output || undefined },
          null,
          2
        );
      } catch (err) {
        return JSON.stringify(
          {
            command: 'pull',
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

import type { DroneToolDefinition } from 'drone-core';
import { runGit, resolveCwd } from '../run-git.js';
import { GitDiffBlock } from '../../../tui/components/GitDiffBlock.js';

export function createDiffTool(): DroneToolDefinition {
  return {
    name: 'diff',
    description:
      'Show a diff. By default the unstaged working-tree diff; pass staged=true for the staged (--cached) diff. Optional path restricts to one file.',
    inputSchema: {
      type: 'object',
      properties: {
        staged: {
          type: 'boolean',
          description: 'Show staged diff (--cached). Default false.',
        },
        path: {
          type: 'string',
          description: 'Restrict to a single file (optional).',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (default: cwd).',
        },
      },
      additionalProperties: false,
    },
    renderComponent: state => GitDiffBlock({ state }),
    execute: async input => {
      const cwd = resolveCwd(input);
      const args = ['diff'];
      if (input.staged === true) {
        args.push('--cached');
      }
      if (typeof input.path === 'string' && input.path.trim().length > 0) {
        args.push('--', input.path.trim());
      }
      const output = await runGit(args, cwd);
      return JSON.stringify({ diff: output }, null, 2);
    },
  };
}

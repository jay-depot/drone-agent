import type { DroneToolDefinition } from 'drone-core';
import { runGit, requireString, resolveCwd } from '../run-git.js';
import { BranchBlock } from '../components/BranchBlock.js';

const ACTIONS = ['list', 'create', 'switch', 'delete'] as const;
type Action = (typeof ACTIONS)[number];

export function createBranchTool(): DroneToolDefinition {
  return {
    name: 'branch',
    description:
      'Branch operations. action: list (default) | create | switch | delete. create/switch need name; delete honors force. list returns all local branches with the current one marked.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'Branch action. Default list.',
        },
        name: {
          type: 'string',
          description: 'Branch name (for create/switch/delete).',
        },
        force: {
          type: 'boolean',
          description: 'Force delete (with action delete). Default false.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (default: cwd).',
        },
      },
      additionalProperties: false,
    },
    renderComponent: state => BranchBlock({ state }),
    execute: async input => {
      const cwd = resolveCwd(input);
      const action = (
        typeof input.action === 'string' ? input.action : 'list'
      ) as Action;

      if (action === 'list') {
        const out = await runGit(['branch', '--format=%(refname:short)'], cwd);
        const branches = out
          .split('\n')
          .map(b => b.trim())
          .filter(Boolean);
        const currentRaw = await runGit(
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          cwd
        );
        const current = currentRaw.trim();
        return JSON.stringify({ action, current, branches }, null, 2);
      }

      const name = requireString(input, 'name');
      let output: string;
      if (action === 'create') {
        output = await runGit(['branch', name], cwd);
      } else if (action === 'switch') {
        output = await runGit(['switch', name], cwd);
      } else if (action === 'delete') {
        output = await runGit(
          input.force === true
            ? ['branch', '-D', name]
            : ['branch', '-d', name],
          cwd
        );
      } else {
        throw new Error(`Unknown branch action: ${action}`);
      }

      return JSON.stringify({ action, name, message: output || 'ok' }, null, 2);
    },
  };
}

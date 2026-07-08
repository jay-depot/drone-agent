import type { DroneToolDefinition } from 'drone-core';
import { runGit, resolveCwd, asPaths } from '../run-git.js';
import { nameStatusToItems, type ListItem } from '../types.js';
import { StashBlock } from '../components/StashBlock.js';

const ACTIONS = ['list', 'push', 'pop', 'apply', 'drop', 'clear'] as const;
type Action = (typeof ACTIONS)[number];

export function createStashTool(): DroneToolDefinition {
  return {
    name: 'stash',
    description:
      'Stash operations. action: list (default) | push | pop | apply | drop | clear. push honors message and paths; apply/drop take index (default 0).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'Stash action. Default list.',
        },
        message: { type: 'string', description: 'Stash message (for push).' },
        index: {
          type: 'number',
          description: 'Stash index for apply/drop. Default 0.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific paths to stash (for push).',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (default: cwd).',
        },
      },
      additionalProperties: false,
    },
    renderComponent: state => StashBlock({ state }),
    execute: async input => {
      const cwd = resolveCwd(input);
      const action = (
        typeof input.action === 'string' ? input.action : 'list'
      ) as Action;

      let files: ListItem[] = [];
      let message: string | undefined;

      if (action === 'push') {
        const args = ['stash', 'push'];
        if (
          typeof input.message === 'string' &&
          input.message.trim().length > 0
        ) {
          args.push('-m', input.message.trim());
        }
        const paths = asPaths(input);
        if (paths) {
          args.push('--', ...paths);
        }
        message = await runGit(args, cwd);
        const status = await runGit(
          ['stash', 'show', '-u', '--name-status', 'stash@{0}'],
          cwd
        ).catch(() => '');
        files = nameStatusToItems(status);
      } else if (action === 'pop') {
        message = await runGit(['stash', 'pop'], cwd);
      } else if (action === 'apply') {
        const idx =
          typeof input.index === 'number'
            ? Math.max(0, Math.floor(input.index))
            : 0;
        message = await runGit(['stash', 'apply', `stash@{${idx}}`], cwd);
      } else if (action === 'drop') {
        const idx =
          typeof input.index === 'number'
            ? Math.max(0, Math.floor(input.index))
            : 0;
        message = await runGit(['stash', 'drop', `stash@{${idx}}`], cwd);
      } else if (action === 'clear') {
        message = await runGit(['stash', 'clear'], cwd);
      } else {
        const out = await runGit(['stash', 'list'], cwd);
        const lines = out
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean);
        files = lines.map(l => ({ kind: 'modified' as const, path: l }));
      }

      return JSON.stringify(
        { action, message: message || undefined, files },
        null,
        2
      );
    },
  };
}

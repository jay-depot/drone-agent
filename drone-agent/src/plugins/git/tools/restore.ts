import type { DroneToolDefinition } from 'drone-core';
import { runGit, resolveCwd, asPaths } from '../run-git.js';
import { nameStatusToItems } from '../types.js';
import { RestoreBlock } from '../components/RestoreBlock.js';

export function createRestoreTool(): DroneToolDefinition {
  return {
    name: 'restore',
    description:
      'Undo changes. Set staged:true to unstage files (git restore --staged). Set discard:true (requires paths) to discard worktree edits (git restore) — this is irreversible, so discard must be explicitly true. discard:true without paths is rejected. staged:true and discard:true cannot be combined (rejected).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific file paths (optional; may use path instead).',
        },
        path: { type: 'string', description: 'Single file path (optional).' },
        staged: {
          type: 'boolean',
          description: 'Unstage files (restore --staged). Default false.',
        },
        discard: {
          type: 'boolean',
          description:
            'Discard worktree changes (restore). Requires paths and is irreversible. Default false.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (default: cwd).',
        },
      },
      additionalProperties: false,
    },
    renderComponent: state => RestoreBlock({ state }),
    execute: async input => {
      const cwd = resolveCwd(input);
      const paths = asPaths(input);
      const staged = input.staged === true;
      const discard = input.discard === true;

      if (discard && !paths) {
        throw new Error(
          'restore with discard:true requires paths (irreversible otherwise).'
        );
      }
      // staged + discard is contradictory: --staged restores the index, while
      // discard reverts the worktree. Reject rather than silently guessing.
      if (staged && discard) {
        throw new Error(
          'restore with both staged:true and discard:true is contradictory (cannot unstage and discard simultaneously).'
        );
      }

      const args: string[] = ['restore'];
      if (staged) {
        args.push('--staged');
      }
      if (paths) {
        args.push('--', ...paths);
      } else if (!staged && !discard) {
        throw new Error(
          'restore requires paths, or staged:true to unstage everything.'
        );
      }

      await runGit(args, cwd);

      // Report what changed, colored by actual FS change. `git diff
      // --name-status` is the format nameStatusToItems expects (tab-separated
      // status codes), so do NOT pass `git status --porcelain` here.
      const status = await runGit(['diff', '--name-status'], cwd);
      const files = nameStatusToItems(status);
      return JSON.stringify({ staged, files }, null, 2);
    },
  };
}

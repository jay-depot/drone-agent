import type { DroneToolDefinition } from 'drone-core';
import { runGit, resolveCwd } from '../run-git.js';
import { nameStatusToItems } from '../types.js';
import { RestoreBlock } from '../components/RestoreBlock.js';

function asPaths(input: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(input.paths) && input.paths.length > 0) {
    return input.paths.map(p => String(p).trim()).filter(Boolean);
  }
  if (typeof input.path === 'string' && input.path.trim().length > 0) {
    return [input.path.trim()];
  }
  return undefined;
}

export function createRestoreTool(): DroneToolDefinition {
  return {
    name: 'restore',
    description:
      'Undo changes. Set staged:true to unstage files (git restore --staged). Set discard:true (requires paths) to discard worktree edits (git restore) — this is irreversible, so discard must be explicitly true. discard:true without paths is rejected.',
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

      const args: string[] = ['restore'];
      if (staged) {
        args.push('--staged');
      }
      if (discard) {
        // Discard worktree changes: no --staged, operate on given paths.
        if (staged) {
          // staged + discard is contradictory; prefer unstaging.
          args.length = 1;
          args.push('--staged');
        }
      }
      if (paths) {
        args.push('--', ...paths);
      } else if (!staged && !discard) {
        throw new Error(
          'restore requires paths, or staged:true to unstage everything.'
        );
      }

      await runGit(args, cwd);

      // Report what changed, colored by actual FS change.
      const status = await runGit(['status', '--porcelain=v1'], cwd);
      const files = nameStatusToItems(status);
      return JSON.stringify({ staged, files }, null, 2);
    },
  };
}

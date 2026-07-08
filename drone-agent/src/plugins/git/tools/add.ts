import type { DroneToolDefinition } from 'drone-core';
import { runGit, resolveCwd, asPaths } from '../run-git.js';
import { nameStatusToItems } from '../types.js';
import { AddBlock } from '../components/AddBlock.js';

export function createAddTool(): DroneToolDefinition {
  return {
    name: 'add',
    description:
      'Stage changes. Pass paths (array) to stage specific files, or all:true to stage all tracked+modified (git add -u), or all:true with includeUntracked:true to also stage new files (git add -A). One of paths or all:true is required (no silent staging of the whole tree).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Specific file paths to stage (required unless all:true).',
        },
        all: {
          type: 'boolean',
          description:
            'Stage all tracked modifications (git add -u). Required if paths is omitted.',
        },
        includeUntracked: {
          type: 'boolean',
          description:
            'With all:true, also stage untracked files (git add -A). Default false.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (default: cwd).',
        },
      },
      additionalProperties: false,
    },
    renderComponent: state => AddBlock({ state }),
    execute: async input => {
      const cwd = resolveCwd(input);

      const args: string[] = ['add'];
      const paths = asPaths(input);
      if (paths) {
        args.push(...paths);
      } else if (input.all === true) {
        if (input.includeUntracked === true) {
          args.push('-A');
        } else {
          args.push('-u');
        }
      } else {
        // Require explicit intent: either specific paths or all:true. Never
        // silently stage the entire tree.
        throw new Error(
          'git add requires either paths (array) or all:true to stage changes.'
        );
      }

      await runGit(args, cwd);

      // Report what was staged, colored by actual FS change. `git diff
      // --cached --name-status` is tab-separated (the format nameStatusToItems
      // expects), so paths resolve correctly.
      const status = await runGit(['diff', '--cached', '--name-status'], cwd);
      const files = nameStatusToItems(status);
      return JSON.stringify({ files }, null, 2);
    },
  };
}

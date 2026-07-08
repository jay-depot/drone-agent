import type { DroneToolDefinition } from 'drone-core';
import { runGit, resolveCwd } from '../run-git.js';
import { nameStatusToItems } from '../types.js';
import { AddBlock } from '../components/AddBlock.js';

export function createAddTool(): DroneToolDefinition {
  return {
    name: 'add',
    description:
      'Stage changes. Pass paths (array) to stage specific files, or all:true to stage all tracked+modified (git add -u), or all:true with includeUntracked:true to also stage new files (git add -A).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific file paths to stage (optional).',
        },
        all: {
          type: 'boolean',
          description:
            'Stage all tracked modifications (git add -u). Default false.',
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
      if (Array.isArray(input.paths) && input.paths.length > 0) {
        args.push(...input.paths.map(p => String(p).trim()).filter(Boolean));
      } else if (input.all === true) {
        if (input.includeUntracked === true) {
          args.push('-A');
        } else {
          args.push('-u');
        }
      } else {
        // Default when nothing specified: stage all tracked updates.
        args.push('-u');
      }

      await runGit(args, cwd);

      // Report what was staged, colored by actual FS change.
      const status = await runGit(['diff', '--cached', '--name-status'], cwd);
      const files = nameStatusToItems(status);
      return JSON.stringify({ files }, null, 2);
    },
  };
}

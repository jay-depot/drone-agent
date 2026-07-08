import type { DroneToolDefinition } from 'drone-core';
import { runGit, requireString, resolveCwd } from '../run-git.js';
import { ShowBlock } from '../components/ShowBlock.js';

export function createShowTool(): DroneToolDefinition {
  return {
    name: 'show',
    description:
      'Show a git object. With just `ref`, shows the commit diff. With `path`, shows that file. Set contentsOnly:true (requires path) to show the file contents at `ref` instead of the diff.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Commit/object ref, e.g. HEAD, main, <hash>.',
        },
        path: { type: 'string', description: 'File path (optional).' },
        contentsOnly: {
          type: 'boolean',
          description:
            'If true and path is set, show file contents at ref instead of the diff. Default false.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (default: cwd).',
        },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    renderComponent: state => ShowBlock({ state }),
    execute: async input => {
      const ref = requireString(input, 'ref');
      const cwd = resolveCwd(input);
      const path =
        typeof input.path === 'string' && input.path.trim().length > 0
          ? input.path.trim()
          : undefined;
      const contentsOnly = input.contentsOnly === true;

      // contentsOnly requires a path; without it the flag is ignored (falls back to diff).
      if (contentsOnly && path) {
        try {
          const contents = await runGit(['show', `${ref}:${path}`], cwd);
          return JSON.stringify(
            { ref, path, contentsOnly: true, contents },
            null,
            2
          );
        } catch {
          return JSON.stringify(
            {
              ref,
              path,
              contentsOnly: true,
              error: `No such path at ${ref}: ${path}`,
            },
            null,
            2
          );
        }
      }

      // Default: commit diff (vs parent).
      const output = await runGit(['show', ref], cwd);
      return JSON.stringify({ ref, path, diff: output }, null, 2);
    },
  };
}

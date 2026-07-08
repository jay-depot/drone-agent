import type { DroneToolDefinition } from 'drone-core';
import { runGit, requireString, resolveCwd, asPaths } from '../run-git.js';
import { CommitBlock } from '../components/CommitBlock.js';

export function createCommitTool(): DroneToolDefinition {
  return {
    name: 'commit',
    description:
      'Create a commit. Does NOT auto-stage. Pass explicit paths to stage and commit just those files, or all:true to commit all tracked modifications (git add -u), or all:true with includeUntracked:true for new files too (git add -A).',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific file paths to stage then commit (optional).',
        },
        all: {
          type: 'boolean',
          description:
            'Stage all tracked modifications before commit. Default false.',
        },
        includeUntracked: {
          type: 'boolean',
          description:
            'With all:true, also stage untracked files. Default false.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (default: cwd).',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
    renderComponent: state => CommitBlock({ state }),
    execute: async input => {
      const message = requireString(input, 'message');
      const cwd = resolveCwd(input);
      const paths = asPaths(input);

      // Stage selection (never silent git add -A).
      const addArgs: string[] = ['add'];
      if (paths) {
        addArgs.push(...paths);
      } else if (input.all === true) {
        addArgs.push(input.includeUntracked === true ? '-A' : '-u');
      } else {
        // Nothing staged explicitly: commit only what is already staged.
      }

      let hash: string | undefined;
      let filesChanged: number | undefined;
      let insertions: number | undefined;
      let deletions: number | undefined;
      try {
        if (addArgs.length > 1) {
          await runGit(addArgs, cwd);
        }
        const output = await runGit(['commit', '-m', message.trim()], cwd);
        const hashMatch = output.match(/\[[^\]]+ ([a-f0-9]+)\]/);
        hash = hashMatch ? hashMatch[1] : undefined;

        // Stats from the new commit (best effort).
        const stat = await runGit(
          ['show', '--stat', '--oneline', '--format=', hash ?? 'HEAD'],
          cwd
        ).catch(() => '');
        const fileMatch = stat.match(/(\d+) file(?:s)? changed/);
        filesChanged = fileMatch ? Number(fileMatch[1]) : undefined;
        const insMatch = stat.match(/(\d+) insertion/);
        insertions = insMatch ? Number(insMatch[1]) : undefined;
        const delMatch = stat.match(/(\d+) deletion/);
        deletions = delMatch ? Number(delMatch[1]) : undefined;
      } catch (err) {
        return JSON.stringify(
          {
            success: false,
            explanation: err instanceof Error ? err.message : String(err),
          },
          null,
          2
        );
      }

      return JSON.stringify(
        {
          success: true,
          hash,
          message: message.trim(),
          filesChanged,
          insertions,
          deletions,
        },
        null,
        2
      );
    },
  };
}

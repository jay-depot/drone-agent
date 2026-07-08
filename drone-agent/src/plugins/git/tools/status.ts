import type { DroneToolDefinition } from 'drone-core';
import { runGit, statusPorcelain, resolveCwd } from '../run-git.js';
import { parsePorcelain } from '../parse-porcelain.js';
import { StatusBlock } from '../components/StatusBlock.js';

export function createStatusTool(): DroneToolDefinition {
  return {
    name: 'status',
    description:
      'Working tree status: staged, unstaged, and untracked files. Correctly distinguishes staged vs unstaged by reading the porcelain index column.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Working directory (default: cwd).',
        },
      },
      additionalProperties: false,
    },
    renderComponent: state => StatusBlock({ state }),
    execute: async input => {
      const cwd = resolveCwd(input);
      const raw = await statusPorcelain(cwd);
      const parsed = parsePorcelain(raw);
      const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      return JSON.stringify(
        {
          branch,
          staged: parsed.staged,
          unstaged: parsed.unstaged,
          untracked: parsed.untracked,
        },
        null,
        2
      );
    },
  };
}

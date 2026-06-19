import { execSync } from 'node:child_process';
import type { DronePlugin } from 'drone-core';

export const gitPlugin: DronePlugin = {
  metadata: {
    id: 'git',
    name: 'Git',
    version: '0.1.0',
    description: 'Git status, diff, commit, and log operations.',
    defaultEnabled: false,
  },
  register: async registration => {
    function runGit(args: string[], cwd?: string): string {
      const dir = cwd ?? process.cwd();
      const stdout = execSync(`git ${args.join(' ')}`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return stdout.trim();
    }

    // -----------------------------------------------------------------------
    // git.status
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'status',
      description:
        'Show the working tree status. Returns staged, unstaged, and untracked changes.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: {
            type: 'string',
            description:
              'Working directory for the git command. Defaults to current working directory.',
          },
        },
        additionalProperties: false,
      },
      execute: async input => {
        const cwd =
          typeof input.cwd === 'string' && input.cwd.trim().length > 0
            ? input.cwd.trim()
            : undefined;
        const output = runGit(['status', '--porcelain'], cwd);
        const lines = output.length > 0 ? output.split('\n') : [];
        const staged: string[] = [];
        const unstaged: string[] = [];
        const untracked: string[] = [];

        for (const line of lines) {
          const stagedFlag = line[0];
          const unstagedFlag = line[1];
          const filePath = line.slice(2).trim();
          if (stagedFlag === '?' && unstagedFlag === '?') {
            untracked.push(filePath);
          } else {
            if (stagedFlag !== ' ') {
              staged.push(`${stagedFlag} ${filePath}`);
            }
            if (unstagedFlag !== ' ') {
              unstaged.push(`${unstagedFlag} ${filePath}`);
            }
          }
        }

        const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
        return JSON.stringify({ branch, staged, unstaged, untracked }, null, 2);
      },
    });

    // -----------------------------------------------------------------------
    // git.diff
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'diff',
      description:
        'Show unstaged diff (default) or staged diff with --staged flag.',
      inputSchema: {
        type: 'object',
        properties: {
          staged: {
            type: 'boolean',
            description:
              'If true, show staged diff (--cached). Default false (unstaged).',
          },
          path: {
            type: 'string',
            description:
              'Optional file path to restrict the diff to a specific file.',
          },
          cwd: {
            type: 'string',
            description:
              'Working directory for the git command. Defaults to current working directory.',
          },
        },
        additionalProperties: false,
      },
      execute: async input => {
        const cwd =
          typeof input.cwd === 'string' && input.cwd.trim().length > 0
            ? input.cwd.trim()
            : undefined;
        const args = ['diff'];
        if (input.staged === true) {
          args.push('--cached');
        }
        if (typeof input.path === 'string' && input.path.trim().length > 0) {
          args.push('--', input.path.trim());
        }
        const output = runGit(args, cwd);
        return JSON.stringify({ diff: output }, null, 2);
      },
    });

    // -----------------------------------------------------------------------
    // git.commit
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'commit',
      description:
        'Stage all changes (git add -A) and commit with a message. Returns the commit hash.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Commit message.',
          },
          cwd: {
            type: 'string',
            description:
              'Working directory for the git command. Defaults to current working directory.',
          },
        },
        required: ['message'],
        additionalProperties: false,
      },
      execute: async input => {
        if (
          typeof input.message !== 'string' ||
          input.message.trim().length === 0
        ) {
          throw new Error('git.commit requires a non-empty message string.');
        }
        const cwd =
          typeof input.cwd === 'string' && input.cwd.trim().length > 0
            ? input.cwd.trim()
            : undefined;

        runGit(['add', '-A'], cwd);
        const output = runGit(
          ['commit', '-m', quoteArg(input.message.trim())],
          cwd
        );
        // Extract commit hash from output like "[main abc1234] message"
        const hashMatch = output.match(/\[[^\]]+ ([a-f0-9]+)\]/);
        return JSON.stringify(
          {
            success: true,
            hash: hashMatch ? hashMatch[1] : undefined,
            output,
          },
          null,
          2
        );
      },
    });

    // -----------------------------------------------------------------------
    // git.log
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'log',
      description:
        'Show recent commit history. Returns commit hash, author, date, and message for each entry.',
      inputSchema: {
        type: 'object',
        properties: {
          maxCount: {
            type: 'number',
            description: 'Maximum number of commits to show. Default 10.',
          },
          path: {
            type: 'string',
            description:
              'Optional file path to restrict the log to a specific file.',
          },
          cwd: {
            type: 'string',
            description:
              'Working directory for the git command. Defaults to current working directory.',
          },
        },
        additionalProperties: false,
      },
      execute: async input => {
        const cwd =
          typeof input.cwd === 'string' && input.cwd.trim().length > 0
            ? input.cwd.trim()
            : undefined;
        const maxCount =
          typeof input.maxCount === 'number' && Number.isFinite(input.maxCount)
            ? Math.max(1, Math.floor(input.maxCount))
            : 10;

        const args = [
          'log',
          `--max-count=${maxCount}`,
          `--format=%H|||%an|||%ai|||%s`,
        ];
        if (typeof input.path === 'string' && input.path.trim().length > 0) {
          args.push('--', input.path.trim());
        }

        const output = runGit(args, cwd);
        const entries = output
          .split('\n')
          .filter(line => line.length > 0)
          .map(line => {
            const parts = line.split('|||');
            return {
              hash: parts[0] ?? '',
              author: parts[1] ?? '',
              date: parts[2] ?? '',
              message: parts[3] ?? '',
            };
          });

        return JSON.stringify({ entries }, null, 2);
      },
    });
  },
};

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9_./@~-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

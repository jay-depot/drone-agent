import { execSync } from 'node:child_process';
import type { DronePlugin } from 'drone-core';

export const searchPlugin: DronePlugin = {
  metadata: {
    id: 'search',
    name: 'Search',
    version: '0.1.0',
    description: 'Text and code search across the workspace.',
    defaultEnabled: false,
  },
  register: async registration => {
    // -----------------------------------------------------------------------
    // search.text
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'text',
      description:
        'Search for a pattern in files using ripgrep (rg) or a fallback grep. Supports regex and plain-text modes. Results include file path, line number, and matching line content.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Search pattern (regex by default, or plain text).',
          },
          path: {
            type: 'string',
            description:
              'Directory or file to search in. Defaults to current working directory.',
          },
          fixed: {
            type: 'boolean',
            description:
              'Treat pattern as a fixed/literal string instead of regex. Default false.',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of matches to return. Default 50.',
          },
          glob: {
            type: 'string',
            description: 'Optional glob filter (e.g. "*.ts" or "src/**/*.js").',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      execute: async input => {
        if (
          typeof input.pattern !== 'string' ||
          input.pattern.trim().length === 0
        ) {
          throw new Error('search.text requires a non-empty pattern string.');
        }

        const searchPath =
          typeof input.path === 'string' && input.path.trim().length > 0
            ? input.path.trim()
            : process.cwd();
        const maxResults =
          typeof input.maxResults === 'number' &&
          Number.isFinite(input.maxResults)
            ? Math.max(1, Math.floor(input.maxResults))
            : 50;
        const fixedFlag = input.fixed === true;

        // Prefer ripgrep for speed, fall back to grep.
        let cmd: string;
        try {
          execSync('which rg', { stdio: 'ignore' });
          const globFlag =
            typeof input.glob === 'string' && input.glob.trim().length > 0
              ? ` --glob "${input.glob.trim()}"`
              : '';
          cmd = `rg --no-heading --line-number --max-count ${maxResults}${fixedFlag ? ' --fixed-strings' : ''}${globFlag} ${quoteArg(input.pattern.trim())} ${quoteArg(searchPath)}`;
        } catch {
          // Fallback to grep -rn
          const globFlag =
            typeof input.glob === 'string' && input.glob.trim().length > 0
              ? ` --include="${input.glob.trim()}"`
              : '';
          cmd = `grep -rn${fixedFlag ? 'F' : 'E'} --max-count=${maxResults}${globFlag} ${quoteArg(input.pattern.trim())} ${quoteArg(searchPath)}`;
        }

        const stdout = execSync(cmd, {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const results = stdout
          .trim()
          .split('\n')
          .filter(line => line.length > 0)
          .slice(0, maxResults)
          .map(line => {
            const match = line.match(/^(.+?):(\d+):(.*)$/);
            if (match) {
              return {
                file: match[1],
                line: parseInt(match[2], 10),
                content: match[3],
              };
            }
            return { file: searchPath, line: 0, content: line };
          });

        return JSON.stringify(
          {
            pattern: input.pattern.trim(),
            searchPath,
            resultCount: results.length,
            truncated: results.length >= maxResults,
            results,
          },
          null,
          2
        );
      },
    });

    // -----------------------------------------------------------------------
    // search.semantic (placeholder)
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'semantic',
      description:
        'Semantic/code-aware search. Currently a placeholder that returns an informational message.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language query about the codebase.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async () => {
        return JSON.stringify(
          {
            note: 'Semantic search is not yet implemented. Use search.text with regex patterns instead.',
          },
          null,
          2
        );
      },
    });
  },
};

function quoteArg(arg: string): string {
  // Simple shell quoting for safety
  if (/^[a-zA-Z0-9_./@~-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

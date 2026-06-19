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
      description: 'Regex/fixed-string search via ripgrep (falls back to grep). Returns file, line, content.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex by default).' },
          path: { type: 'string', description: 'Directory or file (default: cwd).' },
          fixed: { type: 'boolean', description: 'Treat pattern as literal. Default false.' },
          maxResults: { type: 'number', description: 'Max matches. Default 50.' },
          glob: { type: 'string', description: 'Glob filter (e.g. "*.ts").' },
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

        let stdout: string;
        try {
          stdout = execSync(cmd, {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          // rg/grep exit 1 when no matches are found — that's a valid empty
          // result. Exit 2+ indicates a real error (bad pattern, missing
          // path, permission denied). Wrap it so the LLM sees a clear message.
          const status =
            (err as { status?: number | null })?.status ?? null;
          if (status === 1) {
            return JSON.stringify(
              {
                pattern: input.pattern.trim(),
                searchPath,
                resultCount: 0,
                truncated: false,
                results: [],
              },
              null,
              2
            );
          }
          const stderr = (() => {
            if (err && typeof err === 'object' && 'stderr' in err) {
              const s = (err as { stderr?: unknown }).stderr;
              if (typeof s === 'string' && s.length > 0) {
                return s.trim();
              }
              if (Buffer.isBuffer(s) && s.length > 0) {
                return s.toString('utf-8').trim();
              }
            }
            return '';
          })();
          throw new Error(
            `search.text: command failed${status !== null ? ` (exit ${status})` : ''} for ${searchPath}: ${stderr || (err instanceof Error ? err.message : String(err))}`
          );
        }

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
      description: 'Placeholder for semantic search. Use search.text with regex.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
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

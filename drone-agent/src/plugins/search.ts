import type { DronePlugin } from 'drone-core';
import { execFileAsync } from '../shared/exec-async.js';

// ── Ripgrep detection (cached) ──────────────────────────────────────

let hasRipgrep: boolean | null = null;

async function detectRipgrep(): Promise<boolean> {
  if (hasRipgrep !== null) return hasRipgrep;
  try {
    await execFileAsync('which', ['rg']);
    hasRipgrep = true;
  } catch {
    hasRipgrep = false;
  }
  return hasRipgrep;
}

// ── Plugin ───────────────────────────────────────────────────────────

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
    // search__text
    // -----------------------------------------------------------------------
    registration.registerTool({
      name: 'text',
      description:
        'Regex/fixed-string search via ripgrep (falls back to grep). Returns file, line, content. ' +
        'Use mode="semantic" for a placeholder (not yet implemented).',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Search pattern (regex by default).',
          },
          path: {
            type: 'string',
            description: 'Directory or file (default: cwd).',
          },
          fixed: {
            type: 'boolean',
            description: 'Treat pattern as literal. Default false.',
          },
          maxResults: {
            type: 'number',
            description: 'Max matches. Default 50.',
          },
          glob: { type: 'string', description: 'Glob filter (e.g. "*.ts").' },
          mode: {
            type: 'string',
            enum: ['regex', 'semantic'],
            description:
              'Search mode. "regex" (default) uses ripgrep/grep. "semantic" is a placeholder.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      execute: async input => {
        const mode = (input.mode as string) || 'regex';

        if (mode === 'semantic') {
          return JSON.stringify(
            {
              note: 'Semantic search is not yet implemented. Use mode="regex" with regex patterns instead.',
            },
            null,
            2
          );
        }

        if (
          typeof input.pattern !== 'string' ||
          input.pattern.trim().length === 0
        ) {
          throw new Error('search__text requires a non-empty pattern string.');
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
        const fixed = input.fixed === true;
        const glob =
          typeof input.glob === 'string' && input.glob.trim().length > 0
            ? input.glob.trim()
            : undefined;

        // Prefer ripgrep for speed, fall back to grep.
        const useRg = await detectRipgrep();

        let stdout: string;
        try {
          if (useRg) {
            const args: string[] = [
              '--no-heading',
              '--pcre2',
              '--line-number',
              `--max-count=${maxResults}`,
            ];
            if (fixed) args.push('--fixed-strings');
            if (glob) args.push('--glob', glob);
            args.push(input.pattern.trim(), searchPath);
            const result = await execFileAsync('rg', args);
            stdout = result.stdout;
          } else {
            const args: string[] = [
              '-rn',
              ...(fixed ? ['-F'] : ['-E']),
              `--max-count=${maxResults}`,
            ];
            if (glob) args.push(`--include=${glob}`);
            args.push(input.pattern.trim(), searchPath);
            const result = await execFileAsync('grep', args);
            stdout = result.stdout;
          }
        } catch (err) {
          // rg/grep exit 1 when no matches are found — that's a valid empty
          // result. Exit 2+ indicates a real error.
          // execFile errors have `code` set to the exit code (as a string).
          const exitCode = (err as { code?: number | string })?.code ?? null;
          if (exitCode === 1 || exitCode === '1') {
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
            `search__text: command failed${exitCode !== null ? ` (exit ${exitCode})` : ''} for ${searchPath}: ${stderr || (err instanceof Error ? err.message : String(err))}`
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
  },
};

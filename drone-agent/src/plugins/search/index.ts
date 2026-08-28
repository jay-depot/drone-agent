import type {
  DronePlugin,
  DronePluginRegistration,
  DroneSwarmCapability,
  DroneSearchPath,
  DroneSlashCommandContext,
} from 'drone-core';
import { execFileAsync } from '../../shared/exec-async.js';
import path from 'node:path';

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
    version: '0.3.0',
    description:
      'Text and code search across the workspace. Regex search is always available. ' +
      'Semantic search is available when the swarm plugin is connected to a beacon.',
    defaultEnabled: false,
    dependencies: [{ id: 'swarm', optional: true }],
  },
  register: async registration => {
    // ── search__text tool ──────────────────────────────────────────
    registration.registerTool({
      name: 'text',
      description:
        'Workspace text search with two modes. ' +
        'mode="regex" (default): literal/regex match via ripgrep — best when you know the exact identifier, string, or pattern. ' +
        'mode="semantic": vector similarity search via the beacon — best when searching by concept or intent ' +
        '(e.g. "where is rate limiting implemented?"), when you don\'t know the exact wording, ' +
        'or when a regex search returned zero or too many matches. ' +
        'Semantic results are file + score + snippet (no line numbers); follow up with file__read. ' +
        'Semantic mode requires a beacon connection; without one it returns an explanatory note.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'Search pattern (regex by default, or query text for semantic mode).',
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
          minScore: {
            type: 'number',
            description:
              'Minimum cosine similarity score (0.0–1.0) for semantic search results. ' +
              'Only results at or above this threshold are returned. Default 0.0 (no filtering).',
          },
          mode: {
            type: 'string',
            enum: ['regex', 'semantic'],
            description:
              'Search mode. "regex" (default) uses ripgrep/grep. "semantic" uses vector similarity search via the beacon.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      execute: async input => {
        const mode = (input.mode as string) || 'regex';

        if (mode === 'semantic') {
          return handleSemanticSearch(input, registration);
        }

        return handleRegexSearch(input);
      },
    });

    // ── /search-files slash command ────────────────────────────────
    registration.registerSlashCommand({
      command: '/search-files',
      description: 'Search files: regex (default) or semantic (--semantic)',
      handler: async (ctx: DroneSlashCommandContext) => {
        const parsed = parseSearchFilesArgs(ctx.args);
        if (!parsed) {
          ctx.logger.info(
            'Usage: /search-files <pattern> [--semantic] [--path <dir>] [--limit N] [--glob <g>]'
          );
          return true;
        }

        const input: Record<string, unknown> = {
          pattern: parsed.pattern,
          mode: parsed.mode,
          path: parsed.path,
          maxResults: parsed.limit,
        };
        if (parsed.glob) input.glob = parsed.glob;

        let raw: string;
        try {
          raw = await ctx.engine.executeTool('search__text', input);
        } catch (err) {
          ctx.logger.error(
            `search failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return true;
        }

        const data = JSON.parse(raw) as Record<string, unknown>;

        if (parsed.mode === 'semantic') {
          ctx.logger.info(formatSemanticResults(parsed.pattern, data));
        } else {
          ctx.logger.info(formatRegexResults(data));
        }
        return true;
      },
    });

    registration.registerHelp(
      '/search-files <pattern> [--semantic] [--path <dir>] [--limit N] [--glob <g>]'
    );

    // ── Lifecycle ───────────────────────────────────────────────────
    registration.hooks.onPluginsLoaded(async () => {
      const config = registration.getConfig();
      const searchConfig = config.search;

      if (!searchConfig?.enabled) {
        registration.logger.info(
          'search plugin loaded (semantic search disabled by config)'
        );
        return;
      }

      // Check if swarm is available
      const swarmCap = registration.request<DroneSwarmCapability>('swarm');

      if (!swarmCap) {
        registration.logger.info(
          'search: swarm plugin not available; semantic search will not be available. ' +
            'Enable the swarm plugin and connect to a beacon for semantic search.'
        );
        return;
      }

      // Register search paths with the beacon
      const directories = searchConfig.paths ?? [];
      if (directories.length === 0) {
        registration.logger.info(
          'search: no search paths configured; skipping beacon registration'
        );
        return;
      }

      const beaconUrl = swarmCap.getBeaconUrl();
      const agentId = swarmCap.getAgentId();

      try {
        const response = await fetch(
          `${beaconUrl}/agents/${agentId}/search-paths`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: directories }),
          }
        );

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          registration.logger.warn(
            `search: failed to register search paths with beacon (HTTP ${response.status}): ${body}`
          );
          return;
        }

        const result = (await response.json()) as {
          indexed: boolean;
          paths: string[];
        };
        registration.logger.info(
          `search: registered ${result.paths.length} path(s) with beacon (indexed: ${result.indexed})`
        );

        // Register a prompt fragment so the model knows which directories
        // are indexed for semantic search.
        const dirList = directories.map(d => `  - ${d.path}`).join('\n');
        registration.registerPromptFragment({
          key: 'search-indexed-directories',
          phase: 'header',
          render: async () =>
            `# Search Index\n` +
            `The following directories are indexed for semantic (vector) search — query them by\n` +
            `meaning rather than exact text:\n` +
            `${dirList}\n` +
            `\n` +
            `When to use \`search__text\` with \`mode: "semantic"\` vs regex:\n` +
            `- Use semantic when searching by concept, behavior, or intent (e.g. "where is\n` +
            `  session expiry handled", "code that validates config") or when you don't know\n` +
            `  the exact identifier/wording used in the code.\n` +
            `- Use regex (default) when you know the exact symbol, string, or pattern.\n` +
            `- If a regex search returns zero results or an overwhelming number, retry the\n` +
            `  intent semantically.\n` +
            `Semantic results return file, score, and a content snippet (no line numbers);\n` +
            `read the file with \`file__read\` for full context. Lower \`minScore\` (e.g. 0.3) if\n` +
            `too few results; raise it to filter noise.\n`,
        });
      } catch (err) {
        registration.logger.warn(
          `search: failed to connect to beacon for search path registration: ${err}`
        );
      }
    });
  },
};

// ── Search handlers ───────────────────────────────────────────────────

function collectExcludes(
  paths: DroneSearchPath[],
  queryPath: string | undefined
): string[] {
  const out = new Set<string>();
  const target = queryPath ? path.resolve(queryPath) : undefined;
  for (const p of paths) {
    const abs = path.resolve(p.path);
    const applies = target === undefined || target.startsWith(abs);
    if (applies) p.exclude?.forEach(e => out.add(e));
  }
  return [...out];
}

async function handleSemanticSearch(
  input: Record<string, unknown>,
  registration: DronePluginRegistration
): Promise<string> {
  const swarmCap = registration.request<DroneSwarmCapability>('swarm');

  if (!swarmCap) {
    return JSON.stringify(
      {
        note:
          'Semantic search requires a beacon connection. ' +
          'Enable the swarm plugin and connect to a beacon to use semantic search. ' +
          'Alternatively, use an MCP server for vector search.',
      },
      null,
      2
    );
  }

  const query =
    typeof input.pattern === 'string' && input.pattern.trim().length > 0
      ? input.pattern.trim()
      : '';
  if (!query) {
    throw new Error(
      'search__text with mode="semantic" requires a non-empty pattern (query).'
    );
  }

  const maxResults =
    typeof input.maxResults === 'number' && Number.isFinite(input.maxResults)
      ? Math.max(1, Math.floor(input.maxResults))
      : 50;

  const minScore =
    typeof input.minScore === 'number' && Number.isFinite(input.minScore)
      ? Math.max(0, Math.min(1, input.minScore))
      : 0.0;

  const searchPath =
    typeof input.path === 'string' && input.path.trim().length > 0
      ? input.path.trim()
      : undefined;

  const beaconUrl = swarmCap.getBeaconUrl();
  const agentId = swarmCap.getAgentId();

  const params = new URLSearchParams();
  params.set('q', query);
  params.set('maxResults', String(maxResults));
  params.set('minScore', String(minScore));
  if (searchPath) params.set('path', searchPath);
  const searchConfig = registration.getConfig().search;
  const excludes = collectExcludes(searchConfig?.paths ?? [], searchPath);
  for (const e of excludes) params.append('exclude', e);

  try {
    const response = await fetch(
      `${beaconUrl}/agents/${agentId}/search?${params.toString()}`,
      { method: 'GET' }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Beacon search failed (HTTP ${response.status}): ${body || response.statusText}`
      );
    }

    const data = (await response.json()) as {
      query: string;
      resultCount: number;
      truncated: boolean;
      results: Array<{
        file: string;
        chunkIndex: number;
        content: string;
        score: number;
      }>;
    };

    return JSON.stringify(data, null, 2);
  } catch (err) {
    throw new Error(
      `Semantic search failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

async function handleRegexSearch(
  input: Record<string, unknown>
): Promise<string> {
  if (typeof input.pattern !== 'string' || input.pattern.trim().length === 0) {
    throw new Error('search__text requires a non-empty pattern string.');
  }

  const searchPath =
    typeof input.path === 'string' && input.path.trim().length > 0
      ? input.path.trim()
      : process.cwd();
  const maxResults =
    typeof input.maxResults === 'number' && Number.isFinite(input.maxResults)
      ? Math.max(1, Math.floor(input.maxResults))
      : 50;
  const fixed = input.fixed === true;
  const glob =
    typeof input.glob === 'string' && input.glob.trim().length > 0
      ? input.glob.trim()
      : undefined;

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
      `search__text: command failed${exitCode !== null ? ` (exit ${exitCode})` : ''} for ${searchPath}: ${stderr || (err instanceof Error ? err.message : String(err))}`,
      { cause: err }
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
}

// ── /search-files helpers ────────────────────────────────────────────

type SearchFilesArgs = {
  pattern: string;
  mode: 'regex' | 'semantic';
  path: string;
  limit: number;
  glob: string | null;
};

export function parseSearchFilesArgs(args: string[]): SearchFilesArgs | null {
  let mode: 'regex' | 'semantic' = 'regex';
  let pathArg = process.cwd();
  let limit = 10;
  let glob: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--semantic':
        mode = 'semantic';
        break;
      case '--path':
        pathArg = args[++i];
        if (pathArg === undefined) return null;
        break;
      case '--limit': {
        const raw = args[++i];
        if (raw === undefined) return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 1) return null;
        limit = Math.floor(n);
        break;
      }
      case '--glob':
        glob = args[++i];
        if (glob === undefined) return null;
        break;
      default:
        if (arg.startsWith('--')) return null;
        positional.push(arg);
    }
  }

  const pattern = positional.join(' ').trim();
  if (!pattern) return null;

  return { pattern, mode, path: pathArg, limit, glob };
}

export function extractSnippet(
  query: string,
  chunkText: string,
  maxLen = 200
): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0);

  const sentences = chunkText
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (sentences.length === 0) return '';

  let best = sentences[0];
  let bestScore = -1;
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const score = terms.filter(t => lower.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }

  if (best.length <= maxLen) return best;

  // Trim to a window around the first matched term.
  const lower = best.toLowerCase();
  const firstMatch = terms.find(t => lower.includes(t));
  if (firstMatch) {
    const idx = lower.indexOf(firstMatch);
    const start = Math.max(0, idx - Math.floor(maxLen / 3));
    const end = Math.min(best.length, start + maxLen);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < best.length ? '…' : '';
    const budget = maxLen - prefix.length - suffix.length;
    const trimmedStart = Math.max(0, idx - Math.floor(budget / 3));
    const trimmedEnd = Math.min(best.length, trimmedStart + budget);
    return prefix + best.slice(trimmedStart, trimmedEnd).trim() + suffix;
  }

  return best.slice(0, maxLen).trim() + '…';
}

function formatRegexResults(data: Record<string, unknown>): string {
  const results = (data.results ?? []) as Array<{
    file: string;
    line: number;
    content: string;
  }>;
  const count = (data.resultCount as number) ?? results.length;
  const truncated = data.truncated === true;

  const lines = results.map(r => `  ${r.file}:${r.line}   ${r.content}`);
  return [
    `${count} result${count === 1 ? '' : 's'}${truncated ? ' (truncated)' : ''}`,
    ...lines,
  ].join('\n');
}

function formatSemanticResults(
  query: string,
  data: Record<string, unknown>
): string {
  if (data.note) {
    return String(data.note);
  }

  const results = (data.results ?? []) as Array<{
    file: string;
    score: number;
    content: string;
  }>;
  const count = (data.resultCount as number) ?? results.length;
  const truncated = data.truncated === true;

  const lines: string[] = [];
  for (const r of results) {
    const snippet = extractSnippet(query, r.content);
    lines.push(`  ${r.score.toFixed(2)}  ${r.file}`);
    lines.push(`        ${snippet}`);
  }
  return [
    `${count} result${count === 1 ? '' : 's'}${truncated ? ' (truncated)' : ''}`,
    ...lines,
  ].join('\n');
}

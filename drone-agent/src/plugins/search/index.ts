import type {
  DronePlugin,
  DronePluginRegistration,
  DroneSwarmCapability,
} from 'drone-core';
import { execFileAsync } from '../../shared/exec-async.js';

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
        'Regex/fixed-string search via ripgrep (falls back to grep). ' +
        'Returns file, line, content. ' +
        'Use mode="semantic" for semantic (vector) search when a beacon connection is available.',
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
            `The following directories are indexed for semantic search. ` +
            `Use \`search__text\` with \`mode: "semantic"\` to query them ` +
            `by meaning rather than regex.\n` +
            `${dirList}\n`,
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
      `Semantic search failed: ${err instanceof Error ? err.message : String(err)}`
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
}

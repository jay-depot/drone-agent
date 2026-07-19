import path from 'node:path';
import os from 'node:os';
import type {
  DronePlugin,
  DroneSearchCapability,
  DroneEmbeddingProvider,
} from 'drone-core';
import { execFileAsync } from '../../shared/exec-async.js';
import { SearchStore } from './store.js';
import { runIndexing } from './indexer.js';
import { semanticSearch } from './searcher.js';
import { createOllamaEmbeddingProvider } from './providers/ollama.js';

// ── Embedding Provider Registry ──────────────────────────────────────

const embeddingProviders: DroneEmbeddingProvider[] = [];

function registerEmbeddingProvider(provider: DroneEmbeddingProvider): void {
  const existingIdx = embeddingProviders.findIndex(p => p.id === provider.id);
  if (existingIdx !== -1) {
    embeddingProviders[existingIdx] = provider;
  } else {
    embeddingProviders.push(provider);
  }
}

function unregisterEmbeddingProvider(id: string): void {
  const idx = embeddingProviders.findIndex(p => p.id === id);
  if (idx !== -1) {
    embeddingProviders.splice(idx, 1);
  }
}

function getEmbeddingProviders(): DroneEmbeddingProvider[] {
  return [...embeddingProviders];
}

function resolveProvider(
  scope: 'user' | 'project',
  _dirPath?: string
): DroneEmbeddingProvider | undefined {
  const config = getConfigRef();
  if (!config) return undefined;

  const searchConfig = config.search;
  if (!searchConfig) return undefined;

  const providerId =
    scope === 'user'
      ? searchConfig.userEmbeddingProvider
      : searchConfig.projectEmbeddingProvider;

  if (providerId) {
    const provider = embeddingProviders.find(p => p.id === providerId);
    if (provider) return provider;
  }

  // Fall back to first available provider
  return embeddingProviders[0];
}

// ── Config reference (set during registration) ──────────────────────

let getConfigRef: () => import('drone-core').DroneAgentConfig | null = () =>
  null;

// ── Store references (set during onPluginsLoaded) ───────────────────

let userStore: SearchStore | null = null;
let projectStore: SearchStore | null = null;

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
    version: '0.2.0',
    description:
      'Text and code search across the workspace, with semantic search support.',
    defaultEnabled: false,
  },
  register: async registration => {
    getConfigRef = () => registration.getConfig();

    // ── Capability ──────────────────────────────────────────────────
    const capability: DroneSearchCapability = {
      registerEmbeddingProvider,
      unregisterEmbeddingProvider,
      getEmbeddingProviders,
      resolveProvider,
    };
    registration.offer(capability);

    // ── search__text tool ──────────────────────────────────────────
    registration.registerTool({
      name: 'text',
      description:
        'Regex/fixed-string search via ripgrep (falls back to grep). ' +
        'Returns file, line, content. ' +
        'Use mode="semantic" for semantic (vector) search when an embedding provider is available.',
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
              'Search mode. "regex" (default) uses ripgrep/grep. "semantic" uses vector similarity search.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      execute: async input => {
        const mode = (input.mode as string) || 'regex';

        if (mode === 'semantic') {
          return handleSemanticSearch(input);
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

      // Initialize stores
      const projectDir = process.cwd();
      userStore = new SearchStore('user');
      projectStore = new SearchStore('project', projectDir);
      await userStore.ensureDir();
      await projectStore.ensureDir();

      // Register the Ollama embedding provider if available
      const ollamaHost = config.ollama.host;
      if (ollamaHost) {
        try {
          const provider = createOllamaEmbeddingProvider({
            host: ollamaHost,
          });
          registerEmbeddingProvider(provider);
          registration.logger.info(
            `search: registered Ollama embedding provider (${provider.name})`
          );
        } catch (err) {
          registration.logger.warn(
            `search: failed to register Ollama embedding provider: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Run initial indexing
      const directories = searchConfig.paths ?? [];
      if (directories.length > 0) {
        const provider = resolveProvider('project');
        if (provider && projectStore) {
          registration.logger.info(
            `search: starting initial indexing of ${directories.length} directory/directories...`
          );
          const result = await runIndexing({
            store: projectStore,
            provider,
            directories,
            logger: registration.logger,
          });
          registration.logger.info(
            `search: indexing complete — ${result.filesIndexed} indexed, ${result.filesSkipped} skipped, ${result.filesRemoved} removed, ${result.chunksCreated} chunks`
          );

          // Register a prompt fragment so the model knows which directories
          // are indexed for semantic search.
          const dirList = directories
            .map(d => `  - ${d.path}`)
            .join('\n');
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
        } else {
          registration.logger.info(
            'search: no embedding provider available, skipping indexing'
          );
        }
      }
    });

    registration.hooks.onShutdown(async () => {
      if (userStore) {
        userStore.close();
        userStore = null;
      }
      if (projectStore) {
        projectStore.close();
        projectStore = null;
      }
    });
  },
};

// ── Search handlers ───────────────────────────────────────────────────

async function handleSemanticSearch(
  input: Record<string, unknown>
): Promise<string> {
  const providers = getEmbeddingProviders();
  if (providers.length === 0) {
    return JSON.stringify(
      {
        note:
          'Semantic search is not available — no embedding providers are registered. ' +
          'Ensure Ollama is running and has the nomic-embed-text model installed.',
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

  // Determine which store to use based on the path
  const searchPath =
    typeof input.path === 'string' && input.path.trim().length > 0
      ? input.path.trim()
      : process.cwd();

  // Resolve the store and provider
  const projectDir = process.cwd();
  const isProjectPath = searchPath.startsWith(projectDir);
  const store = isProjectPath ? projectStore : userStore;

  if (!store) {
    return JSON.stringify(
      {
        note: 'Semantic search index is not initialized. Enable search in config and restart.',
      },
      null,
      2
    );
  }

  const provider = resolveProvider(isProjectPath ? 'project' : 'user');
  if (!provider) {
    return JSON.stringify(
      {
        note: 'No embedding provider available for semantic search.',
      },
      null,
      2
    );
  }

  try {
    const results = await semanticSearch({
      store,
      provider,
      query,
      maxResults,
      minScore,
    });

    return JSON.stringify(
      {
        query,
        resultCount: results.length,
        truncated: results.length >= maxResults,
        results: results.map(r => ({
          file: r.filePath,
          chunkIndex: r.chunkIndex,
          content: r.text,
          score: r.score,
        })),
      },
      null,
      2
    );
  } catch (err) {
    throw new Error(
      `Semantic search failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleRegexSearch(
  input: Record<string, unknown>
): Promise<string> {
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

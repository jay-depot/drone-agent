import type { FastifyInstance } from 'fastify';
import type { DroneSearchPath } from 'drone-core';
import { dedupeAndCombineChunks } from 'drone-swarm-common';
import { minimatch } from 'minimatch';
import { getSearchIndexer } from './context.js';
import { getAgent } from '../db/agents.js';
import * as db from '../db/index.js';
import { logger } from '../logger.js';
import path from 'node:path';

// Fetch this many times maxResults candidates from the vector index so that
// exclude filtering and per-file dedup can still yield maxResults files.
const OVERFETCH_FACTOR = 4;

function isExcluded(
  filePath: string,
  rootDir: string,
  patterns: string[]
): boolean {
  if (patterns.length === 0) return false;
  const rel = path.relative(rootDir, filePath);
  return patterns.some(p => minimatch(rel, p));
}

export default function searchRoutes(app: FastifyInstance) {
  // ── Set search paths for an agent ────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: { paths: DroneSearchPath[] };
  }>('/agents/:id/search-paths', async (request, reply) => {
    const { id } = request.params;
    const { paths } = request.body;

    // Validate agent exists
    const agent = getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' });
    }

    // Get current paths for this agent
    const currentPaths = db.listSearchPaths(id);
    const newDirs = new Set(paths.map(p => path.resolve(p.path)));

    // Remove paths that are no longer configured
    for (const cp of currentPaths) {
      if (!newDirs.has(cp.directory_path)) {
        db.unregisterSearchPath(id, cp.directory_path);
        // Only remove index if no other agent uses this directory
        const remainingAgents = db.getAgentsForDirectory(cp.directory_path);
        if (remainingAgents.length === 0) {
          const indexer = getSearchIndexer();
          if (indexer) {
            await indexer.removeDirectory(cp.directory_path).catch(err => {
              logger.warn(
                `Failed to remove index for ${cp.directory_path}: ${err}`
              );
            });
          }
        }
      }
    }

    // Add new paths and trigger indexing
    const indexed: string[] = [];
    for (const sp of paths) {
      const absDir = path.resolve(sp.path);
      db.registerSearchPath(id, absDir);
      indexed.push(absDir);

      // Trigger background indexing
      const indexer = getSearchIndexer();
      if (indexer) {
        indexer.indexDirectory(absDir).catch(err => {
          logger.warn(
            `Search index: background indexing failed for ${absDir}: ${err}`
          );
        });
      }
    }

    return {
      indexed: indexed.length > 0,
      paths: indexed,
    };
  });

  // ── Semantic search ──────────────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: {
      q: string;
      maxResults?: number;
      minScore?: number;
      path?: string;
      exclude?: string | string[];
    };
  }>('/agents/:id/search', async (request, reply) => {
    const { id } = request.params;
    const {
      q,
      maxResults,
      minScore,
      path: searchPath,
      exclude,
    } = request.query;
    const excludePatterns = Array.isArray(exclude)
      ? exclude
      : exclude
        ? [exclude]
        : [];

    // Validate agent exists
    const agent = getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' });
    }

    if (!q || q.trim().length === 0) {
      return reply.code(400).send({ error: 'Query parameter "q" is required' });
    }

    // Verify agent has access to the requested path
    const agentPaths = db.listSearchPaths(id);
    const allowedDirs = agentPaths.map(p => p.directory_path);

    let directoryPath: string | undefined;
    if (searchPath) {
      const absPath = path.resolve(searchPath);
      const matchingDir = allowedDirs.find(d => absPath.startsWith(d));
      if (!matchingDir) {
        return reply.code(403).send({
          error: `Agent does not have access to search path: ${searchPath}`,
        });
      }
      directoryPath = matchingDir;
    }

    const indexer = getSearchIndexer();
    if (!indexer) {
      return reply.code(503).send({ error: 'Search indexer not initialized' });
    }

    const provider = indexer.getProvider();
    if (!provider) {
      return reply.code(503).send({ error: 'No embedding provider available' });
    }

    // Get query embedding
    const queryEmbedding = await provider.getEmbedding(`search_query: ${q}`);

    // Fetch a larger candidate set than maxResults so exclude filtering and
    // dedup can still yield maxResults files.
    const overFetch = (maxResults ?? 50) * OVERFETCH_FACTOR;
    const candidates = db.searchChunksByVector(
      queryEmbedding,
      overFetch,
      directoryPath
    );

    const minScoreVal = minScore ?? 0.0;
    const scored = candidates
      .filter(c => c.score >= minScoreVal)
      .filter(c => !isExcluded(c.filePath, c.directoryPath, excludePatterns));

    // Deduplicate by file, keeping the best chunk's score and combining the
    // matching chunks' text (with gap markers for non-consecutive chunks).
    const top = dedupeAndCombineChunks(scored, {
      maxResults: maxResults ?? 50,
    });

    return {
      query: q,
      resultCount: top.length,
      truncated: top.length >= (maxResults ?? 50),
      results: top.map(r => ({
        file: r.filePath,
        chunkIndex: r.chunkIndex,
        content: r.text,
        score: r.score,
      })),
    };
  });

  // ── Trigger reindex ──────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/agents/:id/search/reindex',
    async (request, reply) => {
      const { id } = request.params;

      // Validate agent exists
      const agent = getAgent(id);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const agentPaths = db.listSearchPaths(id);
      if (agentPaths.length === 0) {
        return {
          indexed: false,
          message: 'No search paths configured for this agent',
        };
      }

      const indexer = getSearchIndexer();
      if (!indexer) {
        return reply
          .code(503)
          .send({ error: 'Search indexer not initialized' });
      }

      const results: Array<{
        path: string;
        filesIndexed: number;
        filesSkipped: number;
        filesRemoved: number;
        chunksCreated: number;
      }> = [];
      for (const ap of agentPaths) {
        const result = await indexer.indexDirectory(ap.directory_path);
        results.push({
          path: ap.directory_path,
          ...result,
        });
      }

      return { indexed: true, results };
    }
  );
}

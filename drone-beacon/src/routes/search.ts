import type { FastifyInstance } from 'fastify';
import type { DroneSearchPath } from 'drone-core';
import {
  MAX_PITCH_CHARS,
  computeKeywordCoverage,
  contentTerms,
  dedupeAndCombineChunks,
  fuseMemoryResults,
  getWikiFtsMeta,
  type FileCandidate,
  type WikiCandidate,
} from 'drone-swarm-common';
import { minimatch } from 'minimatch';
import { getRankingConfig, getSearchIndexer } from './context.js';
import { getWikiIndexer } from '../wiki-index-support.js';
import { getAgent } from '../db/agents.js';
import * as db from '../db/index.js';
import { logger } from '../logger.js';
import path from 'node:path';

// Fetch this many times maxResults candidates from the vector index so that
// exclude filtering and per-file dedup can still yield maxResults files.
const OVERFETCH_FACTOR = 4;
// Over-fetch multiplier for the bit-signature prefilter: the Hamming KNN
// shortlist is maxResults * BIT_OVERFETCH rows, rescored by exact cosine
// before the dedup pipeline. Opinionated constant per ADR 181;
// real-corpus calibration may adjust it.
const BIT_OVERFETCH = 8;

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
    const queryEmbedding = await provider.embedQuery(q);

    const maxResultsVal = maxResults ?? 50;

    // Cheap integer-Hamming KNN over the bit-signature mirror, rescored by
    // exact cosine. Rescoring never drops rows, so fewer candidates than
    // requested means the bit stage itself under-delivered (empty/lost mirror
    // or corpus smaller than k) and we fall back to the float KNN path.
    const bitK = maxResultsVal * BIT_OVERFETCH;
    let candidates = db.searchChunksByVectorPrefiltered(
      queryEmbedding,
      bitK,
      directoryPath
    );
    if (candidates.length < bitK) {
      candidates = db.searchChunksByVector(
        queryEmbedding,
        maxResultsVal * OVERFETCH_FACTOR,
        directoryPath
      );
    }

    const minScoreVal = minScore ?? 0.0;
    const scored = candidates
      .filter(c => c.score >= minScoreVal)
      .filter(c => !isExcluded(c.filePath, c.directoryPath, excludePatterns));

    // Deduplicate by file, keeping the best chunk's score and combining the
    // matching chunks' text (with gap markers for non-consecutive chunks).
    const top = dedupeAndCombineChunks(scored, {
      maxResults: maxResultsVal,
    });

    return {
      query: q,
      resultCount: top.length,
      truncated: top.length >= maxResultsVal,
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

  // ── Swarm-memory retrieval (fused) ───────────────────────────────
  //
  // One call replaces the agent's previous 2N fan-out (one request per query
  // input per source). The beacon fans out internally, fuses the results, and
  // returns the final ranked list — so ranking stays a property of the corpus
  // rather than of the asking agent.
  app.post<{
    Body: {
      agentId: string;
      inputs: string[];
      /** Workspace folders to include, with their exclude globs. */
      paths?: Array<{ path: string; exclude?: string[] }>;
      /** Overrides the beacon's configured topK. */
      topK?: number;
    };
  }>('/swarm-memory/retrieve', async (request, reply) => {
    const { agentId, inputs, paths: requestedPaths, topK } = request.body;

    if (!getAgent(agentId)) {
      return reply.code(404).send({ error: 'Agent not found' });
    }

    const cleanInputs = (inputs ?? [])
      .map(i => (typeof i === 'string' ? i.trim() : ''))
      .filter(i => i.length > 0);
    if (cleanInputs.length === 0) {
      return reply.code(400).send({ error: 'inputs must contain a query' });
    }

    const provider =
      getWikiIndexer()?.getProvider() ?? getSearchIndexer()?.getProvider();
    if (!provider) {
      return reply.code(503).send({ error: 'No embedding provider available' });
    }

    const ranking = { ...getRankingConfig() };
    if (typeof topK === 'number' && Number.isFinite(topK) && topK > 0) {
      ranking.topK = Math.floor(topK);
    }
    const overfetch = Math.min(ranking.topK * OVERFETCH_FACTOR, 200);

    // Authorize the requested workspace folders against what this agent
    // actually registered. A folder the agent no longer owns is skipped with a
    // warning rather than failing the whole retrieval — a stale path must not
    // take down memory injection.
    const allowedDirs = db.listSearchPaths(agentId).map(p => p.directory_path);
    const dirs: Array<{ directoryPath: string; exclude: string[] }> = [];
    for (const entry of requestedPaths ?? []) {
      const absPath = path.resolve(entry.path);
      const matchingDir = allowedDirs.find(d => absPath.startsWith(d));
      if (!matchingDir) {
        logger.warn(
          `swarm-memory: agent ${agentId} is not registered for ${entry.path} — skipping`
        );
        continue;
      }
      dirs.push({
        directoryPath: matchingDir,
        exclude: entry.exclude ?? [],
      });
    }

    const wikiCandidates: WikiCandidate[] = [];
    const fileCandidates: FileCandidate[] = [];
    const wikiIndexer = getWikiIndexer();

    for (const input of cleanInputs) {
      const embedding = await provider.embedQuery(input);

      if (wikiIndexer) {
        const hits = db.searchWikiChunksByVector(embedding, overfetch);
        const meta = getWikiFtsMeta(
          () => db.getDatabase(),
          hits.map(h => ({ pageId: h.pageId, origin: h.origin }))
        );
        for (const hit of hits) {
          const m = meta.get(`${hit.origin}\u0000${hit.pageId}`);
          wikiCandidates.push({
            pageId: hit.pageId,
            origin: hit.origin,
            title: m?.title ?? hit.pageId,
            tags: m?.tags ?? [],
            score: hit.score,
            ...(m?.pitch ? { pitch: m.pitch } : {}),
            matchedChunk: hit.text,
          });
        }
      }

      for (const dir of dirs) {
        const hits = db.searchChunksByVector(
          embedding,
          overfetch,
          dir.directoryPath
        );
        for (const hit of hits) {
          if (isExcluded(hit.filePath, hit.directoryPath, dir.exclude))
            continue;
          fileCandidates.push({
            filePath: hit.filePath,
            score: hit.score,
            snippet: hit.text,
          });
        }
      }
    }

    // Keyword coverage is scored against the CURRENT query only. The other
    // inputs are assembled window text, where a content-term denominator would
    // drive coverage to ~0 for every page.
    const terms = contentTerms(cleanInputs[0] ?? '');
    const coverage = computeKeywordCoverage(
      () => db.getDatabase(),
      terms,
      wikiCandidates.map(c => ({ pageId: c.pageId, origin: c.origin }))
    );

    return fuseMemoryResults(
      { wiki: wikiCandidates, files: fileCandidates, coverage, ranking },
      MAX_PITCH_CHARS
    );
  });
}

import type { FastifyInstance } from 'fastify';
import { proxyWikiToCoordinator } from './context.js';
import { searchWikiChunksByVector } from '../db/index.js';
import type { WikiOrigin } from '../db/index.js';
import {
  getWikiIndexer,
  runWikiIndexCycle,
  triggerWikiReindex,
} from '../wiki-index-support.js';

const OVERFETCH_FACTOR = 4;
const MAX_SEMANTIC_RESULTS = 50;

export default function wikiRoutes(app: FastifyInstance) {
  // List all wiki pages (beacon + coordinator)
  app.get('/wiki', async () => {
    const { listPages } = await import('drone-swarm-common');
    const localPages = await listPages();
    const coordinatorPages = await proxyWikiToCoordinator('GET', '/wiki');
    if (coordinatorPages && Array.isArray(coordinatorPages)) {
      return [...localPages, ...coordinatorPages];
    }
    return localPages;
  });

  // Get a single wiki page (local or coordinator)
  app.get<{ Params: { pageId: string }; Querystring: { scope?: string } }>(
    '/wiki/:pageId',
    async (request, reply) => {
      if (request.query.scope === 'coordinator') {
        const result = await proxyWikiToCoordinator(
          'GET',
          `/wiki/${request.params.pageId}`
        );
        if (!result) {
          return reply.code(404).send({ error: 'Wiki page not found' });
        }
        return result;
      }

      const { readPage } = await import('drone-swarm-common');
      const page = await readPage(request.params.pageId);
      if (!page) {
        return reply.code(404).send({ error: 'Wiki page not found' });
      }
      return page;
    }
  );

  // Create or update a wiki page (local or coordinator)
  app.put<{
    Params: { pageId: string };
    Body: {
      title: string;
      content: string;
      scope?: string;
      tags?: string[];
      sources?: string[];
    };
  }>('/wiki/:pageId', async (request, reply) => {
    const { pageId } = request.params;
    const { title, content, scope, tags, sources } = request.body;
    if (!title || !content) {
      return reply.code(400).send({ error: 'title and content are required' });
    }

    if (scope === 'coordinator') {
      const result = await proxyWikiToCoordinator(
        'PUT',
        `/wiki/${pageId}`,
        request.body
      );
      if (!result) {
        return reply
          .code(502)
          .send({ error: 'Failed to proxy to coordinator' });
      }
      return reply.code(200).send(result);
    }

    const { writePage } = await import('drone-swarm-common');
    try {
      const page = await writePage(
        pageId,
        title,
        (scope as 'beacon' | 'coordinator') || 'beacon',
        content,
        tags ?? [],
        sources ?? []
      );
      triggerWikiReindex();
      return reply.code(200).send(page);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Delete a wiki page (local or coordinator)
  app.delete<{ Params: { pageId: string }; Querystring: { scope?: string } }>(
    '/wiki/:pageId',
    async (request, reply) => {
      if (request.query.scope === 'coordinator') {
        const result = await proxyWikiToCoordinator(
          'DELETE',
          `/wiki/${request.params.pageId}`
        );
        if (!result) {
          return reply.code(404).send({ error: 'Wiki page not found' });
        }
        return result;
      }

      const { deletePage } = await import('drone-swarm-common');
      const deleted = await deletePage(request.params.pageId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Wiki page not found' });
      }
      triggerWikiReindex();
      return { success: true };
    }
  );

  // Reindex the wiki vector store against the merged authoritative corpus
  app.post('/wiki/reindex', async (_request, reply) => {
    const indexer = getWikiIndexer();
    if (!indexer) {
      return reply
        .code(503)
        .send({ error: 'Wiki indexer unavailable (no embedding provider)' });
    }
    const result = await runWikiIndexCycle(indexer);
    return { success: true, result };
  });

  // Semantic (vector) search over the merged wiki corpus. Stateless: the
  // agent's proactive-injection module and any other tooling can call it.
  app.get<{
    Querystring: {
      q: string;
      maxResults?: string;
      minScore?: string;
      origin?: string;
    };
  }>('/wiki/semantic-search', async (request, reply) => {
    const { q, maxResults, minScore, origin } = request.query;
    if (!q) {
      return reply.code(400).send({ error: 'q is required' });
    }
    const provider = getWikiIndexer()?.getProvider();
    if (!provider) {
      return reply
        .code(503)
        .send({ error: 'No embedding provider available' });
    }

    const k = Math.min(
      Math.max(parseInt(maxResults ?? '10', 10) || 10, 1),
      MAX_SEMANTIC_RESULTS
    );
    const parsedMinScore = minScore !== undefined ? parseFloat(minScore) : NaN;

    const queryEmbedding = await provider.getEmbedding(`search_query: ${q}`);
    const overfetch = Math.min(k * OVERFETCH_FACTOR, 200);
    const hits = searchWikiChunksByVector(queryEmbedding, overfetch);
    const filtered =
      Number.isFinite(parsedMinScore) && parsedMinScore > 0
        ? hits.filter(h => h.score >= parsedMinScore)
        : hits;

    // Group by (pageId, origin); keep the best-scoring chunk per page.
    interface PageHit {
      pageId: string;
      origin: WikiOrigin;
      score: number;
      matchedChunk: string;
    }
    const byPage = new Map<string, { pageId: string; origin: WikiOrigin; score: number; matchedChunk: string }>();
    for (const hit of filtered) {
      if (origin && hit.origin !== origin) continue;
      const key = `${hit.pageId}\u0000${hit.origin}`;
      const existing = byPage.get(key);
      if (!existing || hit.score > existing.score) {
        byPage.set(key, {
          pageId: hit.pageId,
          origin: hit.origin,
          score: hit.score,
          matchedChunk: hit.text,
        });
      }
    }

    if (byPage.size === 0) {
      return { query: q, resultCount: 0, pageCount: 0, results: [] };
    }

    // Enrich with page metadata (title/tags). Local metadata comes from the
    // local store; coordinator metadata comes from the coordinator page list.
    // Pages whose metadata cannot be resolved (deleted between index and
    // query) are skipped; the next reindex removes their chunks.
    interface PageMetaLite {
      id: string;
      title: string;
      tags: string[];
    }
    const { listPages } = await import('drone-swarm-common');
    const metaByKey = new Map<string, PageMetaLite>();
    for (const p of await listPages()) {
      metaByKey.set(`beacon\u0000${p.id}`, { id: p.id, title: p.title, tags: p.tags });
    }
    if ([...byPage.values()].some(p => p.origin === 'coordinator')) {
      const coordinatorList = (await proxyWikiToCoordinator(
        'GET',
        '/wiki'
      )) as PageMetaLite[] | null;
      if (Array.isArray(coordinatorList)) {
        for (const m of coordinatorList) {
          metaByKey.set(`coordinator\u0000${m.id}`, {
            id: m.id,
            title: m.title,
            tags: Array.isArray(m.tags) ? m.tags : [],
          });
        }
      }
    }

    const results: Array<{
      pageId: string;
      origin: WikiOrigin;
      title: string;
      tags: string[];
      score: number;
      matchedChunk: string;
    }> = [];
    for (const entry of byPage.values()) {
      const meta = metaByKey.get(`${entry.origin}\u0000${entry.pageId}`);
      if (!meta) continue;
      results.push({
        pageId: entry.pageId,
        origin: entry.origin,
        title: meta.title,
        tags: meta.tags,
        score: entry.score,
        matchedChunk: entry.matchedChunk,
      });
    }

    results.sort((a, b) => b.score - a.score);
    const pageResults = results.slice(0, k);
    return {
      query: q,
      resultCount: pageResults.length,
      pageCount: pageResults.length,
      results: pageResults,
    };
  });

  // Lint the local wiki
  app.post('/wiki/lint', async () => {
    const { lintPages } = await import('drone-swarm-common');
    return lintPages();
  });
}
import type { FastifyInstance } from 'fastify';
import { proxyWikiToCoordinator } from './context.js';

export default function wikiRoutes(app: FastifyInstance) {
  // List all wiki pages (beacon + coordinator)
  app.get('/wiki', async () => {
    const { listPages } = await import('drone-swarm-common/wiki-storage');
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

      const { readPage } = await import('drone-swarm-common/wiki-storage');
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

    const { writePage } = await import('drone-swarm-common/wiki-storage');
    try {
      const page = await writePage(
        pageId,
        title,
        (scope as 'beacon' | 'coordinator') || 'beacon',
        content,
        tags ?? [],
        sources ?? []
      );
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

      const { deletePage } = await import('drone-swarm-common/wiki-storage');
      const deleted = await deletePage(request.params.pageId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Wiki page not found' });
      }
      return { success: true };
    }
  );

  // Search wiki pages (beacon + coordinator)
  app.get<{ Querystring: { q: string } }>('/wiki/search', async request => {
    const { searchPages } = await import('drone-swarm-common/wiki-storage');
    const { q } = request.query;
    if (!q) return [];
    const localResults = await searchPages(q);
    const coordinatorResults = await proxyWikiToCoordinator(
      'GET',
      `/wiki/search?q=${encodeURIComponent(q)}`
    );
    if (coordinatorResults && Array.isArray(coordinatorResults)) {
      return [...localResults, ...coordinatorResults];
    }
    return localResults;
  });

  // Lint the local wiki
  app.post('/wiki/lint', async () => {
    const { lintPages } = await import('drone-swarm-common/wiki-storage');
    return lintPages();
  });
}

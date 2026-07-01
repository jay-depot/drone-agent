import type { FastifyInstance } from 'fastify';

export default function wikiRoutes(app: FastifyInstance) {
  app.get('/wiki', async () => {
    const { listPages } = await import('drone-swarm-common/wiki-storage');
    return listPages();
  });

  app.get<{ Params: { pageId: string } }>(
    '/wiki/:pageId',
    async (request, reply) => {
      const { readPage } = await import('drone-swarm-common/wiki-storage');
      const page = await readPage(request.params.pageId);
      if (!page) {
        return reply.code(404).send({ error: 'Wiki page not found' });
      }
      return page;
    }
  );

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
    const { writePage } = await import('drone-swarm-common/wiki-storage');
    const { pageId } = request.params;
    const { title, content, scope, tags, sources } = request.body;
    if (!title || !content) {
      return reply.code(400).send({ error: 'title and content are required' });
    }
    try {
      const page = await writePage(
        pageId,
        title,
        (scope as 'beacon' | 'coordinator') || 'coordinator',
        content,
        tags ?? [],
        sources ?? []
      );
      return reply.code(200).send(page);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { pageId: string } }>(
    '/wiki/:pageId',
    async (request, reply) => {
      const { deletePage } = await import('drone-swarm-common/wiki-storage');
      const deleted = await deletePage(request.params.pageId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Wiki page not found' });
      }
      return { success: true };
    }
  );

  app.get<{ Querystring: { q: string } }>('/wiki/search', async request => {
    const { searchPages } = await import('drone-swarm-common/wiki-storage');
    const { q } = request.query;
    if (!q) return [];
    return searchPages(q);
  });

  app.post('/wiki/lint', async () => {
    const { lintPages } = await import('drone-swarm-common/wiki-storage');
    return lintPages();
  });
}

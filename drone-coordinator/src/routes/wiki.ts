import type { FastifyInstance } from 'fastify';

export default function wikiRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { tag?: string } }>('/wiki', async request => {
    const { listPages } = await import('drone-swarm-common');
    return listPages(request.query.tag);
  });

  app.get('/wiki/tags', async () => {
    const { listTags } = await import('drone-swarm-common');
    return listTags();
  });

  app.get('/wiki/graph', async () => {
    const { buildGraph } = await import('drone-swarm-common');
    return buildGraph();
  });

  app.get<{ Params: { pageId: string } }>(
    '/wiki/:pageId',
    async (request, reply) => {
      const { readPage } = await import('drone-swarm-common');
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
      pitch?: string;
    };
  }>('/wiki/:pageId', async (request, reply) => {
    const { writePage } = await import('drone-swarm-common');
    const { pageId } = request.params;
    const { title, content, scope, tags, sources, pitch } = request.body;
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
        sources ?? [],
        pitch ?? undefined
      );
      return reply.code(200).send(page);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { pageId: string } }>(
    '/wiki/:pageId',
    async (request, reply) => {
      const { deletePage } = await import('drone-swarm-common');
      const deleted = await deletePage(request.params.pageId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Wiki page not found' });
      }
      return { success: true };
    }
  );

  app.get<{ Querystring: { q: string } }>('/wiki/search', async request => {
    const { searchPages } = await import('drone-swarm-common');
    const { q } = request.query;
    if (!q) return [];
    return searchPages(q);
  });

  app.post('/wiki/lint', async () => {
    const { lintPages } = await import('drone-swarm-common');
    return lintPages();
  });
}

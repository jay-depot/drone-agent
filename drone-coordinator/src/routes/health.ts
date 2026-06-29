import type { FastifyInstance } from 'fastify';

export default function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });
}
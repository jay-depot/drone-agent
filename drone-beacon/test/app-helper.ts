/**
 * Test helper to build a Fastify app instance for beacon route testing.
 * Avoids importing the full index.ts which has TLS, spawner, and WebSocket
 * dependencies that don't resolve in the test environment.
 */
import fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../src/routes/index.js';

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = fastify({
    logger: { level: 'silent' },
  });

  await registerRoutes(app);

  return app;
}

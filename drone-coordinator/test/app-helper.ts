/**
 * Test helper to build a Fastify app instance for route testing.
 * Avoids importing the full index.ts which has TLS dependencies
 * that don't resolve in the test environment.
 */
import fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { registerRoutes } from '../src/routes/index.js';

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = fastify({
    logger: { level: 'silent' },
  });

  await app.register(fastifyCors, {
    origin: true,
  });

  await registerRoutes(app);

  return app;
}

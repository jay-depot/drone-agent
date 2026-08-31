/**
 * Test helper to build a Fastify app instance for route testing.
 * Avoids importing the full index.ts which has TLS dependencies
 * that don't resolve in the test environment.
 */
import fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { registerRoutes } from '../src/routes/index.js';

export async function buildTestApp(opts?: {
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}): Promise<FastifyInstance> {
  const app = fastify({
    logger: { level: 'silent' },
  });

  await app.register(fastifyCors, {
    origin: true,
  });

  if (opts?.rateLimitMax !== undefined) {
    await app.register(import('@fastify/rate-limit'), {
      max: opts.rateLimitMax,
      timeWindow: opts.rateLimitWindowMs ?? 60000,
    });
  }

  await registerRoutes(app);

  return app;
}

import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { listBundles } from '../db/index.js';
import { resolveBundleFilePath } from '../extension-bundles.js';

/**
 * Serve extension bundle assets same-origin (public, like /assets/). The file
 * name is validated path-safe and the (nodeId, hash) pair must match a
 * registered bundle row. Registered on the coordinator's web port by
 * `attachUi`; also used directly by route tests.
 */
export function registerBundleServingRoutes(app: FastifyInstance): void {
  const serve = async (
    kind: 'scripts' | 'styles',
    nodeId: string,
    hash: string,
    fileName: string,
    reply: FastifyReply
  ) => {
    const registered = listBundles(nodeId).some(b => b.hash === hash);
    if (!registered) {
      return reply.code(404).send({ error: 'Bundle not found' });
    }
    const filePath = resolveBundleFilePath(nodeId, hash, fileName);
    if (!filePath) {
      return reply.code(404).send({ error: 'Not found' });
    }
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
    reply.header(
      'Content-Type',
      kind === 'styles' ? 'text/css' : 'application/javascript'
    );
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(content);
  };

  app.get<{ Params: { nodeId: string; hash: string; name: string } }>(
    '/plugin-scripts/:nodeId/:hash/:name',
    async (request, reply) =>
      serve(
        'scripts',
        request.params.nodeId,
        request.params.hash,
        request.params.name,
        reply
      )
  );

  app.get<{ Params: { nodeId: string; hash: string; name: string } }>(
    '/plugin-styles/:nodeId/:hash/:name',
    async (request, reply) =>
      serve(
        'styles',
        request.params.nodeId,
        request.params.hash,
        request.params.name,
        reply
      )
  );
}

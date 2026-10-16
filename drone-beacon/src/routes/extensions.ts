import type { FastifyInstance } from 'fastify';
import { getCoordinatorClient } from './context.js';

/**
 * Beacon proxy route for extension tool calls. The agent's `extensions` plugin
 * POSTs here; the beacon forwards to the coordinator via its typed
 * CoordinatorClient (mTLS), which proxies over the extension's WebSocket. The
 * coordinator's `{ok,status,body}` result is passed through unchanged.
 */
export default function extensionRoutes(app: FastifyInstance) {
  app.post<{
    Params: { nodeId: string; tool: string };
    Body: { params?: unknown; sessionId?: string };
  }>('/coordinator/extensions/:nodeId/tools/:tool', async (request, reply) => {
    const client = getCoordinatorClient();
    if (!client) {
      return reply.code(503).send({ error: 'Coordinator not configured' });
    }
    const sessionId = request.body?.sessionId ?? '';
    return client.invokeExtensionTool(
      request.params.nodeId,
      request.params.tool,
      request.body?.params,
      sessionId
    );
  });
}

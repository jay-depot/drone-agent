import type { FastifyInstance } from 'fastify';
import type { FastifyReply } from 'fastify';
import { validateJsonSchema } from 'drone-swarm-common';
import { EXTENSION_PROTOCOL_VERSION } from 'drone-core';
import type { DroneExtensionCapability } from 'drone-core';
import { sendBeaconCommand, isBeaconConnected } from '../beacon-ws.js';
import {
  getManifest,
  isExtension,
  listExtensionNodeIds,
} from '../extension-registry.js';
import {
  resolveBeaconIdByFingerprint,
  getClientCertFingerprint,
} from '../mtls.js';
import { publishMutationEvent } from '../ws-pubsub.js';
import {
  computeBundleHash,
  writeBundleFiles,
  removeBundleDir,
  bundleFileUrls,
  type BundleFile,
} from '../extension-bundles.js';
import * as db from '../db/index.js';
import { logger } from '../logger.js';

const DEFAULT_TIMEOUT_MS = 15000;

function findCapability(
  nodeId: string,
  name: string
): DroneExtensionCapability | undefined {
  return getManifest(nodeId)?.capabilities.find(c => c.name === name);
}

/**
 * Invoke a capability on an extension: validate params, then proxy over the
 * node's WebSocket. Maps disconnected → 503, timeout → 504, and passes the
 * extension's `{ok,status,body}` through verbatim otherwise.
 */
async function invoke(
  nodeId: string,
  action: string,
  params: unknown,
  caller: 'ui' | 'agent',
  sessionId: string | undefined,
  reply: FastifyReply
): Promise<unknown> {
  if (!isExtension(nodeId)) {
    return reply
      .code(404)
      .send({ error: 'Not an extension', code: 'NOT_EXTENSION' });
  }
  const cap = findCapability(nodeId, action);
  if (!cap) {
    return reply
      .code(404)
      .send({
        error: `Unknown capability: ${action}`,
        code: 'UNKNOWN_CAPABILITY',
      });
  }

  const errors = validateJsonSchema(params ?? {}, cap.paramSchema ?? {});
  if (errors.length > 0) {
    return reply.code(400).send({ error: 'Invalid params', details: errors });
  }

  if (!isBeaconConnected(nodeId)) {
    return reply
      .code(503)
      .send({
        error: 'Extension not connected',
        code: 'EXTENSION_DISCONNECTED',
      });
  }

  try {
    const res = await sendBeaconCommand(
      nodeId,
      caller === 'agent' ? 'invokeTool' : 'invokeAction',
      { action, params, caller, sessionId },
      cap.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const status = res.status ?? (res.ok ? 200 : 502);
    return reply.code(status).send({ ok: res.ok, status, body: res.body });
  } catch (err) {
    const timeout = err instanceof Error && /Timed out/.test(err.message);
    if (timeout) {
      return reply
        .code(504)
        .send({
          error: 'Extension did not respond',
          code: 'EXTENSION_TIMEOUT',
        });
    }
    return reply
      .code(503)
      .send({ error: 'Extension unavailable', code: 'EXTENSION_UNAVAILABLE' });
  }
}

export default function extensionRoutes(app: FastifyInstance) {
  // UI manifest: connected-node registry + last-known cache + bundles.
  app.get('/extensions', async () => {
    const nodeIds = new Set(listExtensionNodeIds());
    for (const row of db.listCapabilityCache()) nodeIds.add(row.nodeId);

    return Promise.all(
      [...nodeIds].map(async nodeId => {
        const manifest =
          getManifest(nodeId) ?? db.getCapabilityCache(nodeId)?.manifest;
        const bundleRows = db.listBundles(nodeId);
        const bundles = await Promise.all(
          bundleRows.map(async row => {
            const urls = await bundleFileUrls(nodeId, row.hash, row.path);
            return {
              name: row.name,
              version: row.version,
              hash: row.hash,
              scriptUrls: urls.scripts,
              styleUrls: urls.styles,
            };
          })
        );
        return {
          nodeId,
          connected: isBeaconConnected(nodeId),
          isExtension: isExtension(nodeId),
          protocolVersion:
            manifest?.protocolVersion ?? EXTENSION_PROTOCOL_VERSION,
          capabilities: manifest?.capabilities ?? [],
          bundles,
        };
      })
    );
  });

  // Invoke a proxied API action (UI/external consumer; web-token protected).
  app.post<{
    Params: { nodeId: string; action: string };
    Body: { params?: unknown; sessionId?: string };
  }>('/extensions/:nodeId/actions/:action', async (request, reply) =>
    invoke(
      request.params.nodeId,
      request.params.action,
      request.body?.params,
      'ui',
      request.body?.sessionId,
      reply
    )
  );

  // Invoke a proxied tool (agent tool call, mTLS via the beacon proxy).
  app.post<{
    Params: { nodeId: string; tool: string };
    Body: { params?: unknown; sessionId?: string };
  }>('/extensions/:nodeId/tools/:tool', async (request, reply) =>
    invoke(
      request.params.nodeId,
      request.params.tool,
      request.body?.params,
      'agent',
      request.body?.sessionId,
      reply
    )
  );

  // Upload/replace a front-end bundle. Auth = the uploading node's mTLS cert.
  app.put<{
    Params: { name: string };
    Body: { version?: string; files?: BundleFile[] };
  }>('/extensions/bundles/:name', async (request, reply) => {
    const fingerprint = getClientCertFingerprint(request);
    const nodeId = fingerprint
      ? resolveBeaconIdByFingerprint(fingerprint)
      : undefined;
    if (!nodeId) {
      return reply
        .code(401)
        .send({ error: 'A registered node certificate is required' });
    }
    const { version, files } = request.body ?? {};
    if (
      typeof version !== 'string' ||
      !version ||
      !Array.isArray(files) ||
      files.length === 0
    ) {
      return reply
        .code(400)
        .send({ error: 'version and a non-empty files array are required' });
    }
    if (
      files.some(
        f => typeof f?.name !== 'string' || typeof f?.contentBase64 !== 'string'
      )
    ) {
      return reply
        .code(400)
        .send({ error: 'each file needs a name and contentBase64' });
    }

    const name = request.params.name;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      return reply.code(400).send({ error: 'Invalid bundle name' });
    }

    const hash = computeBundleHash(files);
    let dir: string;
    try {
      dir = await writeBundleFiles(nodeId, hash, files);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Invalid bundle',
      });
    }

    const previous = db.getBundle(nodeId, name);
    db.upsertBundle({
      nodeId,
      name,
      version,
      hash,
      path: dir,
      updatedAt: Date.now(),
    });
    // Replace semantics: drop the superseded content-hash directory.
    if (previous && previous.hash !== hash) {
      await removeBundleDir(previous.path).catch(err => {
        logger.warn(
          `Failed to remove superseded bundle ${previous.path}: ${err}`
        );
      });
    }

    publishMutationEvent({
      sessionId: nodeId,
      eventType: 'extension.bundle',
      payload: { nodeId, name },
    });
    return reply.code(200).send({ name, version, hash, path: dir });
  });

  // Remove a bundle (disk dir + DB row).
  app.delete<{ Params: { name: string } }>(
    '/extensions/bundles/:name',
    async (request, reply) => {
      const fingerprint = getClientCertFingerprint(request);
      const nodeId = fingerprint
        ? resolveBeaconIdByFingerprint(fingerprint)
        : undefined;
      if (!nodeId) {
        return reply
          .code(401)
          .send({ error: 'A registered node certificate is required' });
      }
      const existing = db.getBundle(nodeId, request.params.name);
      if (!existing) {
        return reply.code(404).send({ error: 'Bundle not found' });
      }
      db.deleteBundle(nodeId, request.params.name);
      await removeBundleDir(existing.path).catch(err => {
        logger.warn(`Failed to remove bundle dir ${existing.path}: ${err}`);
      });
      publishMutationEvent({
        sessionId: nodeId,
        eventType: 'extension.bundle',
        payload: { nodeId, name: request.params.name },
      });
      return reply.code(200).send({ ok: true });
    }
  );
}

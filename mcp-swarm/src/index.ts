/**
 * `mcp-swarm` — the reference swarm extension.
 *
 * Runs as a long-lived daemon: it connects to the coordinator as an extension
 * node (declaring a swarm capability catalog + a front-end bundle) and serves
 * that catalog to external MCP clients over streamable HTTP. MCP tool calls
 * are authenticated by a named bearer token and either run locally (the
 * UI-only `token.*` capabilities) or proxy to the coordinator over the node's
 * mTLS-authenticated fetch.
 *
 * Config via env:
 *   MCP_SWARM_COORDINATOR_URL  (default http://127.0.0.1:8080)
 *   MCP_SWARM_DATA_DIR         (default ~/.drone-agent/mcp-swarm)
 *   MCP_SWARM_ID               (default mcp-swarm)
 *   MCP_SWARM_HOST             (default 127.0.0.1)
 *   MCP_SWARM_PORT             (default 3460)
 */

import os from 'node:os';
import path from 'node:path';
import {
  createExtensionNode,
  redeemPreApprovalToken,
  type ExtensionNode,
} from 'drone-swarm-common';
import { SWARM_CAPABILITIES, isTokenCapability } from './mapping.js';
import { createInvoker } from './mcp-server.js';
import { startMcpHttpServer, type McpHttpServer } from './http-server.js';
import { loadTokenStore, type TokenStore } from './token-store.js';
import { buildBundleFiles, BUNDLE } from './bundle.js';
import type { InvokeResult } from './mapping.js';

export interface McpSwarmConfig {
  coordinatorUrl: string;
  dataDir: string;
  id: string;
  host: string;
  port: number;
  preApprovalTokenPath?: string;
}

/** Resolve config from env with sensible defaults. */
export function resolveConfig(env = process.env): McpSwarmConfig {
  const preApprovalTokenPath = parsePreApprovalTokenPath();
  return {
    coordinatorUrl: env.MCP_SWARM_COORDINATOR_URL ?? 'http://127.0.0.1:8080',
    dataDir:
      env.MCP_SWARM_DATA_DIR ??
      path.join(os.homedir(), '.drone-agent', 'mcp-swarm'),
    id: env.MCP_SWARM_ID ?? 'mcp-swarm',
    host: env.MCP_SWARM_HOST ?? '127.0.0.1',
    port: Number(env.MCP_SWARM_PORT ?? 3460),
    ...(preApprovalTokenPath ? { preApprovalTokenPath } : {}),
  };
}

/**
 * Parse `--pre-approval-token-path` from argv. Accepts both the `=value` and
 * space-separated forms.
 */
export function parsePreApprovalTokenPath(
  argv: string[] = process.argv.slice(2)
): string | undefined {
  const flag = '--pre-approval-token-path';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flag) {
      return argv[i + 1];
    }
    if (arg?.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

/** Run a UI-only `token.*` capability against the token store. */
export function runTokenCapability(
  store: TokenStore,
  capability: string,
  params: Record<string, unknown>
): InvokeResult {
  switch (capability) {
    case 'token.list':
      return { ok: true, status: 200, body: { tokens: store.list() } };
    case 'token.create': {
      const name = String(params.name ?? '').trim();
      if (!name) {
        return {
          ok: false,
          status: 400,
          body: { error: 'A non-empty name is required' },
        };
      }
      const { entry, token } = store.create(name);
      return { ok: true, status: 200, body: { token, entry } };
    }
    case 'token.revoke': {
      const id = String(params.id ?? '');
      return { ok: true, status: 200, body: { revoked: store.revoke(id), id } };
    }
    case 'token.rename': {
      const id = String(params.id ?? '');
      const name = String(params.name ?? '').trim();
      const entry = store.rename(id, name);
      if (!entry) {
        return { ok: false, status: 404, body: { error: 'Unknown token id' } };
      }
      return { ok: true, status: 200, body: { entry } };
    }
    default:
      return {
        ok: false,
        status: 404,
        body: { error: 'Unknown token capability' },
      };
  }
}

/**
 * Start the extension node, the token store, and the MCP HTTP server. Returns
 * a stop function.
 */
export async function startMcpSwarm(
  cfg: McpSwarmConfig = resolveConfig()
): Promise<{
  node: ExtensionNode;
  server: McpHttpServer;
  stop: () => Promise<void>;
}> {
  const store = await loadTokenStore(cfg.dataDir);

  const node = await createExtensionNode({
    coordinatorUrl: cfg.coordinatorUrl,
    dataDir: cfg.dataDir,
    id: cfg.id,
    name: 'mcp-swarm',
    capabilities: SWARM_CAPABILITIES,
    handlers: {
      onInvokeAction: async (capability, params) => {
        if (isTokenCapability(capability)) {
          return runTokenCapability(
            store,
            capability,
            (params ?? {}) as Record<string, unknown>
          );
        }
        return createInvoker(node.getFetch(), cfg.coordinatorUrl)(
          capability,
          (params ?? {}) as Record<string, unknown>
        );
      },
      onInvokeTool: async (capability, params) => {
        if (isTokenCapability(capability)) {
          return runTokenCapability(
            store,
            capability,
            (params ?? {}) as Record<string, unknown>
          );
        }
        return createInvoker(node.getFetch(), cfg.coordinatorUrl)(
          capability,
          (params ?? {}) as Record<string, unknown>
        );
      },
    },
  });

  try {
    await node.uploadBundle({
      name: BUNDLE.name,
      version: BUNDLE.version,
      files: buildBundleFiles(),
    });
  } catch {
    // Non-fatal: the bundle is a UI nicety, not a protocol requirement.
  }

  const server = await startMcpHttpServer({
    capabilities: SWARM_CAPABILITIES,
    invoke: (capability, params) =>
      isTokenCapability(capability)
        ? Promise.resolve(runTokenCapability(store, capability, params))
        : createInvoker(node.getFetch(), cfg.coordinatorUrl)(
            capability,
            params
          ),
    verify: token => store.verify(token) !== undefined,
    host: cfg.host,
    port: cfg.port,
  });

  return {
    node,
    server,
    stop: async () => {
      await server.close();
      await store.flush();
      await node.stop();
    },
  };
}

/** Process entry point. */
export async function main(): Promise<void> {
  const config = resolveConfig();
  if (config.preApprovalTokenPath) {
    try {
      await redeemPreApprovalToken({
        coordinatorUrl: config.coordinatorUrl,
        dataDir: config.dataDir,
        id: config.id,
        name: config.id,
        tokenPath: config.preApprovalTokenPath,
      });
    } catch (err) {
      console.error(
        `Pre-approval failed: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
    console.log('Pre-approval complete. Exiting.');
    return;
  }
  await startMcpSwarm();
}

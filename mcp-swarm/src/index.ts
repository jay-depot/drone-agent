/**
 * `mcp-swarm` — the reference swarm extension.
 *
 * Connects to the coordinator as an extension node (declaring a small swarm
 * capability catalog + a front-end status-panel bundle) and exposes that same
 * catalog to external MCP clients over stdio. Every MCP tool call maps 1:1
 * onto a catalog capability and is executed against the coordinator over the
 * node's mTLS-authenticated fetch.
 *
 * Config via env:
 *   MCP_SWARM_COORDINATOR_URL  (default http://127.0.0.1:3456)
 *   MCP_SWARM_DATA_DIR         (default ~/.drone-agent/mcp-swarm)
 *   MCP_SWARM_ID               (default mcp-swarm)
 */

import os from 'node:os';
import path from 'node:path';
import { createExtensionNode, type ExtensionNode } from 'drone-swarm-common';
import { SWARM_CAPABILITIES } from './mapping.js';
import {
  createInvoker,
  frame,
  startMcpStdioServer,
} from './mcp-server.js';
import { buildStatusPanelFiles, STATUS_PANEL_BUNDLE } from './bundle.js';

export interface McpSwarmConfig {
  coordinatorUrl: string;
  dataDir: string;
  id: string;
}

/** Resolve config from env with sensible defaults. */
export function resolveConfig(env = process.env): McpSwarmConfig {
  return {
    coordinatorUrl:
      env.MCP_SWARM_COORDINATOR_URL ?? 'http://127.0.0.1:3456',
    dataDir:
      env.MCP_SWARM_DATA_DIR ??
      path.join(os.homedir(), '.drone-agent', 'mcp-swarm'),
    id: env.MCP_SWARM_ID ?? 'mcp-swarm',
  };
}

/** Start the extension node + MCP stdio server. Returns a stop function. */
export async function startMcpSwarm(
  cfg: McpSwarmConfig = resolveConfig()
): Promise<{ node: ExtensionNode; stop: () => Promise<void> }> {
  const node = await createExtensionNode({
    coordinatorUrl: cfg.coordinatorUrl,
    dataDir: cfg.dataDir,
    id: cfg.id,
    name: 'mcp-swarm',
    capabilities: SWARM_CAPABILITIES,
    handlers: {
      // An MCP-client-driven action invoked through the coordinator.
      onInvokeAction: async (capability, params) => {
        const result = await createInvoker(
          node.getFetch(),
          cfg.coordinatorUrl
        )(capability, (params ?? {}) as Record<string, unknown>);
        return { ok: result.ok, status: result.status, body: result.body };
      },
      // The same, for a proxied agent tool call.
      onInvokeTool: async (capability, params) => {
        const result = await createInvoker(
          node.getFetch(),
          cfg.coordinatorUrl
        )(capability, (params ?? {}) as Record<string, unknown>);
        return { ok: result.ok, status: result.status, body: result.body };
      },
    },
  });

  // Upload the reference front-end bundle (best-effort — the UI may not be up).
  try {
    await node.uploadBundle({
      name: STATUS_PANEL_BUNDLE.name,
      version: STATUS_PANEL_BUNDLE.version,
      files: buildStatusPanelFiles(),
    });
  } catch {
    // Non-fatal: the bundle is a UI nicety, not a protocol requirement.
  }

  const stopServer = startMcpStdioServer({
    capabilities: SWARM_CAPABILITIES,
    invoke: createInvoker(node.getFetch(), cfg.coordinatorUrl),
    write: payload => process.stdout.write(frame(payload)),
  });

  return {
    node,
    stop: async () => {
      stopServer();
      await node.stop();
    },
  };
}

/** Process entry point. */
export async function main(): Promise<void> {
  await startMcpSwarm();
}

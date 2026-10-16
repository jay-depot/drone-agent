/**
 * MCP JSON-RPC request handling over the capability catalog.
 *
 * Speaks the MCP JSON-RPC 2.0 methods `initialize`, `tools/list`, and
 * `tools/call`, exposing the `mcp`-tier swarm catalog 1:1 as MCP tools. The
 * transport (streamable HTTP) lives in `http-server.ts`; this module only
 * turns a parsed request into a response.
 */

import {
  executeCapability,
  isMcpExposed,
  mcpToolName,
  type InvokeResult,
} from './mapping.js';
import type { DroneExtensionCapability } from 'drone-core';

export interface McpRequestOptions {
  capabilities: DroneExtensionCapability[];
  /** Execute one capability; supplied by the extension node. */
  invoke: (
    capability: string,
    params: Record<string, unknown>
  ) => Promise<InvokeResult>;
  protocolVersion?: string;
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export type Request = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

/**
 * Handle one parsed JSON-RPC request. Returns the response object, or null for
 * a notification (no id) that must not be answered.
 */
export async function handleRequest(
  req: Request,
  opts: McpRequestOptions
): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({
    jsonrpc: '2.0',
    id: req.id,
    result,
  });
  const fail = (code: number, message: string) => ({
    jsonrpc: '2.0',
    id: req.id,
    error: { code, message },
  });

  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-swarm', version: '0.1.0' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: opts.capabilities
          .filter(cap => cap.exposed !== 'ui')
          .map(cap => ({
            name: mcpToolName(cap.name),
            description: cap.description,
            inputSchema: cap.paramSchema,
          })),
      });
    case 'tools/call': {
      const name = req.params?.name as string | undefined;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      if (!name || !opts.capabilities.some(c => c.name === name)) {
        return fail(-32602, `Unknown tool: ${name ?? '(missing)'}`);
      }
      if (!isMcpExposed(name, opts.capabilities)) {
        return fail(-32602, `Tool not available: ${name}`);
      }
      const result = await opts.invoke(name, args);
      if (!result.ok) {
        return reply({
          isError: true,
          content: [
            {
              type: 'text',
              text:
                typeof result.body === 'object' && result.body !== null
                  ? JSON.stringify(result.body)
                  : `swarm capability failed (status ${result.status})`,
            },
          ],
        });
      }
      return reply({
        content: [
          {
            type: 'text',
            text:
              typeof result.body === 'string'
                ? result.body
                : JSON.stringify(result.body, null, 2),
          },
        ],
      });
    }
    default:
      if (req.id === undefined) return null;
      return fail(-32601, `Method not found: ${req.method ?? '(missing)'}`);
  }
}

/** Build the invoke adapter over an mTLS fetch + coordinator base URL. */
export function createInvoker(
  fetchImpl: typeof fetch,
  baseUrl: string
): (
  capability: string,
  params: Record<string, unknown>
) => Promise<InvokeResult> {
  return (capability, params) =>
    executeCapability(capability, params, fetchImpl, baseUrl);
}

/**
 * Minimal, dependency-free MCP stdio server over the capability catalog.
 *
 * Speaks the MCP JSON-RPC 2.0 stdio framing (`Content-Length: N\r\n\r\n{...}`)
 * and exposes the swarm catalogue 1:1 as MCP tools: `initialize`, `tools/list`,
 * and `tools/call`. Each `tools/call` maps straight onto a capability, so the
 * catalog remains the single source of truth for both the MCP surface and the
 * coordinator-proxied action/tool surface.
 */

import { executeCapability, mcpToolName, type InvokeResult } from './mapping.js';
import type { DroneExtensionCapability } from 'drone-core';

export interface McpServerOptions {
  capabilities: DroneExtensionCapability[];
  /** Execute one capability; supplied by the extension node. */
  invoke: (
    capability: string,
    params: Record<string, unknown>
  ) => Promise<InvokeResult>;
  /** Write a framed JSON-RPC message to stdout. */
  write: (payload: string) => void;
  protocolVersion?: string;
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

type Request = {
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
  opts: McpServerOptions
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
        tools: opts.capabilities.map(cap => ({
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

/** Start the stdio loop. Returns a stop function. */
export function startMcpStdioServer(opts: McpServerOptions): () => void {
  let buffer = Buffer.alloc(0);
  let stopped = false;

  const onData = (chunk: Buffer): void => {
    if (stopped) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unparseable frame — drop the header and continue.
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const payload = buffer.subarray(start, start + length).toString('utf8');
      buffer = buffer.subarray(start + length);
      void dispatch(payload);
    }
  };

  const dispatch = async (payload: string): Promise<void> => {
    let req: Request;
    try {
      req = JSON.parse(payload) as Request;
    } catch {
      return;
    }
    const response = await handleRequest(req, opts);
    if (response) opts.write(JSON.stringify(response));
  };

  process.stdin.on('data', onData);
  return () => {
    stopped = true;
    process.stdin.off('data', onData);
  };
}

/** Frame a JSON-RPC payload with the MCP stdio Content-Length header. */
export function frame(payload: string): string {
  return `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
}

/** Build the invoke adapter over an mTLS fetch + coordinator base URL. */
export function createInvoker(
  fetchImpl: typeof fetch,
  baseUrl: string
): (capability: string, params: Record<string, unknown>) => Promise<InvokeResult> {
  return (capability, params) =>
    executeCapability(capability, params, fetchImpl, baseUrl);
}

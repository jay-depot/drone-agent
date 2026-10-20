/**
 * Streamable-HTTP MCP transport for the reference extension.
 *
 * A stateless subset of the MCP streamable-HTTP transport: `POST /mcp`
 * carries a JSON-RPC request and answers `application/json` (no SSE, no
 * session id). `GET /mcp` answers 405 (no server→client stream). `DELETE
 * /mcp` answers 204 (no-op). A notification (no id) answers 202 with no body.
 * Every request must carry `Authorization: Bearer <token>`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleRequest, type McpRequestOptions } from './mcp-server.js';
import type { InvokeResult } from './mapping.js';
import type { DroneExtensionCapability } from 'drone-core';

export interface McpHttpServerOptions {
  capabilities: DroneExtensionCapability[];
  invoke: (
    capability: string,
    params: Record<string, unknown>
  ) => Promise<InvokeResult>;
  verify: (token: string) => boolean;
  host: string;
  port: number;
}

export interface McpHttpServer {
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        resolve('too-large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function extractBearer(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  return token.length > 0 ? token : null;
}

/** Start the MCP HTTP server. Supports `port: 0` for tests. */
export function startMcpHttpServer(
  opts: McpHttpServerOptions
): Promise<McpHttpServer> {
  const requestOptions: McpRequestOptions = {
    capabilities: opts.capabilities,
    invoke: opts.invoke,
  };

  const server = http.createServer((req, res) => {
    void handle(req, res, requestOptions, opts.verify);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.removeListener('error', reject);
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close(err => (err ? fail(err) : done()))
          ),
      });
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestOptions: McpRequestOptions,
  verify: (token: string) => boolean
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }

  const token = extractBearer(req);
  if (!token || !verify(token)) {
    res
      .writeHead(401, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(405).end();
    return;
  }
  if (req.method === 'DELETE') {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }

  const body = await readBody(req);
  if (body === 'too-large') {
    res.writeHead(413, { Connection: 'close' }).end();
    req.destroy();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    res
      .writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const response = await handleRequest(
    parsed as Parameters<typeof handleRequest>[0],
    requestOptions
  );
  if (response === null) {
    res.writeHead(202).end();
    return;
  }

  const payload = JSON.stringify(response);
  res
    .writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload, 'utf8'),
    })
    .end(payload);
}

/**
 * Real MCP server child process for the SLOW integration suite.
 *
 * Speaks standard MCP Content-Length framing over stdio (the default wire
 * format the MCP client uses for `transport: 'stdio'`). It implements the
 * subset of JSON-RPC methods the drone-agent MCP client exercises:
 *   initialize, tools/list, tools/call, resources/list, resources/read,
 *   resources/templates/list, prompts/list, prompts/get, shutdown,
 *   notifications/initialized
 *
 * Configuration comes from environment variables (set by `startFakeMcpServer`
 * in `mcp-fake-server.ts`):
 *   FAKE_MCP_TOOLS        JSON array of tool name strings
 *   FAKE_MCP_TOOLS_FULL   JSON array of { name, description, inputSchema }
 *   FAKE_MCP_CRASH_ON_INIT '1' => exit immediately on initialize (unavailable)
 *   FAKE_MCP_OMIT_SHUTDOWN '1' => return -32601 for shutdown
 */

import process from 'node:process';

function parseEnvTools() {
  if (process.env.FAKE_MCP_TOOLS_FULL) {
    try {
      const full = JSON.parse(process.env.FAKE_MCP_TOOLS_FULL);
      if (Array.isArray(full) && full.length > 0) return full;
    } catch {
      // fall through
    }
  }
  const names = JSON.parse(process.env.FAKE_MCP_TOOLS || '["echo","add"]');
  return names.map(name => ({ name, description: `Fake tool ${name}.` }));
}

const TOOLS = parseEnvTools();

const CRASH_ON_INIT = process.env.FAKE_MCP_CRASH_ON_INIT === '1';
const OMIT_SHUTDOWN = process.env.FAKE_MCP_OMIT_SHUTDOWN === '1';

const RESOURCES = [
  { uri: 'file:///a.txt', name: 'a', description: 'Resource A' },
  { uri: 'file:///b.txt', name: 'b', description: 'Resource B' },
];

const PROMPTS = [
  { name: 'greeting', description: 'A greeting prompt.' },
  { name: 'summarize', description: 'A summarize prompt.' },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'file:///{path}',
    name: 'file',
    description: 'A file addressed by path',
    arguments: [{ name: 'path', required: true }],
  },
];

function send(message) {
  const payload = JSON.stringify(message);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`
  );
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleRequest(method, id, params) {
  switch (method) {
    case 'initialize':
      if (CRASH_ON_INIT) {
        // Simulate a server that can't initialize: exit the process.
        process.exit(1);
      }
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.0' },
      });
      return;
    case 'tools/list':
      respond(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params && params.name;
      respond(id, {
        content: [
          {
            type: 'text',
            text: `called ${name} with ${JSON.stringify(params?.arguments ?? {})}`,
          },
        ],
      });
      return;
    }
    case 'resources/list':
      respond(id, { resources: RESOURCES });
      return;
    case 'resources/read': {
      const uri = params && params.uri;
      respond(id, { contents: [{ uri, text: `contents of ${uri}` }] });
      return;
    }
    case 'resources/templates/list':
      respond(id, { resourceTemplates: RESOURCE_TEMPLATES });
      return;
    case 'prompts/list':
      respond(id, { prompts: PROMPTS });
      return;
    case 'prompts/get': {
      const name = params && params.name;
      respond(id, {
        description: `prompt ${name}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `run ${name} with ${JSON.stringify(params?.arguments ?? {})}`,
            },
          },
        ],
      });
      return;
    }
    case 'shutdown':
      if (OMIT_SHUTDOWN) {
        respondError(id, -32601, 'Method not found');
        return;
      }
      respond(id, { ok: true });
      return;
    default:
      respondError(id, -32601, `Method not found: ${method}`);
      return;
  }
}

let buffer = Buffer.alloc(0);

function parseBuffer() {
  while (true) {
    const sep = buffer.indexOf('\r\n\r\n');
    if (sep === -1) return;
    const header = buffer.subarray(0, sep).toString('utf8');
    const contentLengthLine = header
      .split('\r\n')
      .find(l => l.toLowerCase().startsWith('content-length:'));
    if (!contentLengthLine) {
      process.stderr.write('fake-mcp-server: missing Content-Length\n');
      process.exit(1);
    }
    const contentLength = Number(contentLengthLine.split(':')[1]?.trim());
    const start = sep + 4;
    const end = start + contentLength;
    if (buffer.length < end) return;
    const raw = buffer.subarray(start, end).toString('utf8');
    buffer = buffer.subarray(end);

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      process.stderr.write('fake-mcp-server: invalid JSON\n');
      continue;
    }

    if (message.method && message.id !== undefined) {
      handleRequest(message.method, message.id, message.params);
    }
    // Notifications (no id). The MCP `exit` notification means the server
    // should terminate itself so the client's graceful shutdown is fast.
    if (message.method === 'exit' && message.id === undefined) {
      process.exit(0);
    }
    // notifications (no id) are ignored
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  parseBuffer();
});

process.stdin.on('end', () => {
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

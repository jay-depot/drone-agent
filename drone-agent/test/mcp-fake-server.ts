/**
 * Test doubles for the MCP client.
 *
 * Two layers:
 *
 *  1. `createMockFetch` — an in-process fake of the global `fetch` used by the
 *     streamable-HTTP transport (`createStreamableHttpJsonRpcClient`). Lets the
 *     fast unit suite exercise `createMcpClientConnection` against the HTTP
 *     transport without any network or subprocess. Frames are returned as a
 *     `Response`-shaped object so the client's parsing path is untouched.
 *
 *  2. `startFakeMcpServer` — a descriptor for a real stdio child process
 *     (see `mcp-fake-server.mjs`) used by the slow integration suite, where
 *     child-process lifecycle is the thing under test. The MCP CLIENT spawns
 *     the child from the returned `serverConfig` when the engine boots; the
 *     suite observes that client-owned child (e.g. via a `vi.mock` spawn spy in
 *     the test) and asserts on its shutdown / force-kill behavior.
 *
 * Both layers speak JSON-RPC 2.0 and implement the subset of methods the client
 * uses: `initialize`, `tools/list`, `tools/call`, `resources/list`,
 * `resources/read`, `resources/templates/list`, `prompts/list`, `prompts/get`, and
 * optionally `shutdown`.
 *
 * IMPORTANT (Phase 1): these doubles encode the CLIENT's CURRENT behavior, not
 * the spec-ideal behavior. The HTTP fake only emits an `Mcp-Session-Id` header
 * when `sessionId` is passed, because the current client only captures/echos the
 * id when the server issues one. This is intentional — the tests are the
 * regression net that later fix-phases will update. Do not "fix" the fake to be
 * spec-compliant in a way that diverges from what the current client expects.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type JsonRpcRequest = {
  id: number;
  method: string;
  params?: unknown;
};

export type FakeHandler = (params: unknown) => unknown;

export type MockFetchOptions = {
  /** Override the handler for a JSON-RPC method. */
  handlers?: Record<string, FakeHandler>;
  /** Force every response to be an HTTP error (non-2xx). */
  forceHttpError?: number;
  /** Force specific methods to return an HTTP error. */
  httpErrors?: Record<string, number>;
  /** Session id to return in the Mcp-Session-Id header. */
  sessionId?: string;
  /**
   * Server->client SSE notifications to emit on a GET to the streamable-HTTP
   * endpoint. Each is serialized as a JSON-RPC notification frame
   * `{ method, params }` and sent as an SSE `event:` line.
   */
  sseEvents?: Array<{ method: string; params?: unknown }>;
  /** If true, the GET SSE stream will error immediately. */
  sseError?: boolean;
  /** Number of items per page for paginated list methods. */
  pageSize?: number;
  /** If true, the server returns a bare (non-enveloped) body for all methods. */
  bareResponse?: boolean;
};

export type MockFetch = {
  fetch: typeof fetch;
  requests: Array<{
    method: string;
    params?: unknown;
    headers: Record<string, string>;
  }>;
  callCount: (method: string) => number;
  lastRequest: (method: string) =>
    | {
        method: string;
        params?: unknown;
        headers: Record<string, string>;
      }
    | undefined;
  reset: () => void;
  onRequest: (method: string, handler: FakeHandler) => void;
  onRawResponse: (method: string, body: unknown) => void;
};

// ---------------------------------------------------------------------------
// In-process HTTP mock (fast suite)
// ---------------------------------------------------------------------------

const DEFAULT_TOOLS = [
  { name: 'echo', description: 'Echoes input.' },
  { name: 'weird name!', description: 'A tool with a space in its name.' },
  { name: 'add', description: 'Adds two numbers.' },
];

const DEFAULT_RESOURCES = [
  { uri: 'file:///a.txt', name: 'a', description: 'Resource A' },
  { uri: 'file:///b.txt', name: 'b', description: 'Resource B' },
];

const DEFAULT_PROMPTS = [
  { name: 'greeting', description: 'A greeting prompt.' },
  { name: 'summarize', description: 'A summarize prompt.' },
];

const DEFAULT_RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'file:///{path}',
    name: 'file',
    description: 'A file addressed by path',
    arguments: [{ name: 'path', required: true }],
  },
];

function paginate<T>(items: T[], pageSize: number, cursor?: string) {
  const start = cursor ? Number(cursor) : 0;
  const page = items.slice(start, start + pageSize);
  const nextCursor =
    start + pageSize < items.length ? String(start + pageSize) : undefined;
  return { items: page, nextCursor };
}

export function createMockFetch(
  options: MockFetchOptions = {}
): MockFetch {
  const handlers: Record<string, FakeHandler> = {};
  const rawResponses: Record<string, unknown> = {};
  const requests: Array<{
    method: string;
    params?: unknown;
    headers: Record<string, string>;
  }> = [];

  const pageSize = options.pageSize ?? 100;

  function handle(method: string, params: unknown) {
    if (handlers[method]) return handlers[method](params);

    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'fake-mcp', version: '0.0.0' },
        };
      case 'tools/list': {
        const { items, nextCursor } = paginate(DEFAULT_TOOLS, pageSize, (params as { cursor?: string })?.cursor);
        return { tools: items, nextCursor };
      }
      case 'tools/call': {
        const p = params as { name?: string; arguments?: unknown };
        return {
          content: [
            {
              type: 'text',
              text: `called ${p.name} with ${JSON.stringify(p.arguments ?? {})}`,
            },
          ],
        };
      }
      case 'resources/list': {
        const { items, nextCursor } = paginate(DEFAULT_RESOURCES, pageSize, (params as { cursor?: string })?.cursor);
        return { resources: items, nextCursor };
      }
      case 'resources/read': {
        const uri = (params as { uri?: string })?.uri;
        return { contents: [{ uri, text: `contents of ${uri}` }] };
      }
      case 'resources/templates/list': {
        const { items, nextCursor } = paginate(DEFAULT_RESOURCE_TEMPLATES, pageSize, (params as { cursor?: string })?.cursor);
        return { resourceTemplates: items, nextCursor };
      }
      case 'prompts/list': {
        const { items, nextCursor } = paginate(DEFAULT_PROMPTS, pageSize, (params as { cursor?: string })?.cursor);
        return { prompts: items, nextCursor };
      }
      case 'prompts/get': {
        const name = (params as { name?: string })?.name;
        return {
          description: `prompt ${name}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `run ${name} with ${JSON.stringify((params as { arguments?: unknown })?.arguments ?? {})}`,
              },
            },
          ],
        };
      }
      default:
        throw new Error(`unexpected method: ${method}`);
    }
  }

  const mock: MockFetch = {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const k of Object.keys(h)) {
          headers[k.toLowerCase()] = h[k];
        }
      }

      if (method === 'GET') {
        if (options.sseError) {
          return Promise.resolve(
            new Response(null, { status: 500, statusText: 'SSE error' })
          );
        }
        const events = options.sseEvents ?? [];
        let idx = 0;
        const body = new ReadableStream({
          start(controller) {
            function push() {
              if (idx >= events.length) return;
              const ev = events[idx++];
              const data = JSON.stringify({ jsonrpc: '2.0', method: ev.method, params: ev.params ?? {} });
              controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${data}\n\n`));
              if (idx < events.length) {
                setTimeout(push, 1);
              } else {
                controller.close();
              }
            }
            setTimeout(push, 1);
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              ...(options.sessionId ? { 'mcp-session-id': options.sessionId } : {}),
            },
          })
        );
      }

      if (method === 'DELETE') {
        const httpErr = options.httpErrors?.DELETE;
        if (httpErr) {
          return Promise.resolve(
            new Response(null, { status: httpErr, statusText: String(httpErr) })
          );
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      // POST
      const bodyText = init?.body?.toString() ?? '';
      let body: { method?: string; params?: unknown };
      try {
        body = JSON.parse(bodyText);
      } catch {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: -32700, message: 'Parse error' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }

      const rpcMethod = body.method ?? 'unknown';
      requests.push({ method: rpcMethod, params: body.params, headers });

      const httpErr = options.httpErrors?.[rpcMethod];
      if (httpErr) {
        return Promise.resolve(
          new Response(null, { status: httpErr, statusText: String(httpErr) })
        );
      }

      if (options.forceHttpError) {
        return Promise.resolve(
          new Response(null, { status: options.forceHttpError, statusText: String(options.forceHttpError) })
        );
      }

      let result: unknown;
      try {
        result = handle(rpcMethod, body.params);
      } catch (e) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 0, error: { code: -32603, message: String(e) } }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }

      if (rawResponses[rpcMethod] !== undefined) {
        result = rawResponses[rpcMethod];
      }

      const responseBody = options.bareResponse
        ? result
        : { jsonrpc: '2.0', id: body.id ?? 0, result };

      const responseHeaders: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (options.sessionId && rpcMethod === 'initialize') {
        responseHeaders['mcp-session-id'] = options.sessionId;
      }

      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: responseHeaders,
        })
      );
    }) as unknown as typeof fetch,

    requests,

    callCount(method: string) {
      return requests.filter(r => r.method === method).length;
    },

    lastRequest(method: string) {
      const matches = requests.filter(r => r.method === method);
      return matches.length > 0 ? matches[matches.length - 1] : undefined;
    },

    reset() {
      requests.length = 0;
    },

    onRequest(method: string, handler: FakeHandler) {
      handlers[method] = handler;
    },

    onRawResponse(method: string, body: unknown) {
      rawResponses[method] = body;
    },
  };

  return mock;
}

// ---------------------------------------------------------------------------
// Real stdio child process (slow suite only)
// ---------------------------------------------------------------------------

const SERVER_SCRIPT = path.join(__dirname, 'mcp-fake-server.mjs');

export type FakeMcpServerOptions = {
  /** Tool names to advertise. Defaults to echo/add. */
  toolNames?: string[];
  /** Tool name that triggers a notification on call. */
  notifyOnToolName?: string;
  /** Tool name that triggers a notifications/message on call. */
  notifyMessageOnToolName?: string;
  /** Notification method to send (default: notifications/tools/list_changed). */
  notifyMethod?: string;
  /** If true, the child will refuse `initialize` (e.g. exit immediately). */
  crashOnInit?: boolean;
  /** If true, the child omits `shutdown` (-32601). */
  omitShutdown?: boolean;
  /** Custom tool list to serve (alternative to toolNames). */
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
};

export type FakeMcpServer = {
  /** Absolute path to the fake-server child script (use as config.args[0]). */
  scriptPath: string;
  /**
   * A ready-to-use `DroneMcpStdioServerConfig` fragment. The MCP client spawns
   * its OWN child from this config when the engine boots, so the suite must
   * assert against THAT child — capture it with a `vi.mock('node:child_process')`
   * spawn spy in the test, since the child is owned by the client, not by this
   * descriptor. The env values configure which tools the child serves.
   */
  serverConfig: {
    transport: 'stdio';
    command: string;
    args: string[];
    env: Record<string, string>;
  };
};

/**
 * Build a fake MCP stdio server descriptor. The descriptor does NOT spawn a
 * process itself — the MCP client spawns the child from `serverConfig` when the
 * engine boots. This keeps the suite's lifecycle assertions pointed at the
 * client-owned child process, which is the process whose shutdown / force-kill
 * the suite verifies.
 */
export function startFakeMcpServer(
  options: FakeMcpServerOptions = {}
): FakeMcpServer {
  const env: Record<string, string> = {
    FAKE_MCP_TOOLS: JSON.stringify(options.toolNames ?? ['echo', 'add']),
    FAKE_MCP_TOOLS_FULL: JSON.stringify(options.tools ?? null),
    FAKE_MCP_CRASH_ON_INIT: options.crashOnInit ? '1' : '0',
    FAKE_MCP_OMIT_SHUTDOWN: options.omitShutdown ? '1' : '0',
    FAKE_MCP_NOTIFY_ON_TOOL_NAME: options.notifyOnToolName ?? '',
    FAKE_MCP_NOTIFY_MESSAGE_ON_TOOL_NAME: options.notifyMessageOnToolName ?? '',
    FAKE_MCP_NOTIFY_METHOD:
      options.notifyMethod ?? 'notifications/tools/list_changed',
  };

  return {
    scriptPath: SERVER_SCRIPT,
    serverConfig: {
      transport: 'stdio',
      command: process.execPath,
      args: [SERVER_SCRIPT],
      env,
    },
  };
}

export const __internal = { SERVER_SCRIPT };

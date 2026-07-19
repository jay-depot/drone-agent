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
  /**
   * Per-method HTTP status override. e.g. `{ 'tools/list': 500 }` makes only
   * `tools/list` return a non-2xx response, so `initialize` still succeeds.
   * This is how you test client error-classification on a partial failure.
   */
  httpErrors?: Record<string, number>;
  /**
   * When set, the fake responds to the initialize request with this error code
   * instead of a normal result. Used to test error classification / retry.
   */
  initializeError?: { code: number; message: string };
  /**
   * Default page size for cursor-based pagination in `tools/list` etc. Set to a
   * small number (e.g. 2) to exercise the client's pagination loop.
   */
  pageSize?: number;
  /** Extra tool entries the `tools/list` handler should serve. */
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  /** Extra resource entries. */
  resources?: Array<{ uri: string; name?: string; description?: string }>;
  /** Extra prompt entries. */
  prompts?: Array<{ name: string; description?: string }>;
  /** Extra resource template entries. */
  resourceTemplates?: Array<{
    uriTemplate: string;
    name?: string;
    description?: string;
    arguments?: Array<{
      name: string;
      required?: boolean;
      description?: string;
    }>;
  }>;
  /** Whether `shutdown` is implemented (returns -32601 if false). */
  implementsShutdown?: boolean;
  /**
   * When set, the fake emits an `mcp-session-id` response header on the
   * `initialize` reply, and keeps subsequent responses header-less. This lets
   * the client unit tests verify it captures the id and echoes it on later
   * requests.
   */
  sessionId?: string;
  /**
   * Server->client SSE notifications to emit on a GET to the streamable-HTTP
   * endpoint. Each is serialized as a JSON-RPC notification frame
   * (`{ jsonrpc:'2.0', method, params }`) inside an SSE `data:` block. Used to
   * exercise the client's GET-reader + onNotification dispatch.
   */
  sseEvents?: Array<{ id?: number; method: string; params?: unknown }>;
  /**
   * When true, the GET stream's first `read()` throws (simulating a transient
   * stream drop) instead of delivering the queued `sseEvents`.
   */
  sseError?: boolean;
};

const DEFAULT_TOOLS = [
  { name: 'echo', description: 'Echo a value back.' },
  { name: 'add', description: 'Add two numbers.' },
  {
    name: 'weird name!',
    description: 'A tool whose name needs sanitization.',
  },
];

const DEFAULT_RESOURCES = [
  { uri: 'file:///a.txt', name: 'a', description: 'Resource A' },
  { uri: 'file:///b.txt', name: 'b', description: 'Resource B' },
];

const DEFAULT_RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'file:///{path}',
    name: 'file',
    description: 'A file addressed by path',
    arguments: [
      { name: 'path', required: true, description: 'Filesystem path' },
    ],
  },
  {
    uriTemplate: 'db://users/{userId}',
    name: 'user',
    description: 'A user row addressed by id',
    arguments: [{ name: 'userId', required: true }],
  },
];

const DEFAULT_PROMPTS = [
  { name: 'greeting', description: 'A greeting prompt.' },
  { name: 'summarize', description: 'A summarize prompt.' },
];

type RequestRecord = {
  method: string;
  params: unknown;
  url: string;
  headers: Record<string, string>;
  /** JSON-RPC id (present on both requests and responses). */
  id?: number;
  /** Result field (present on responses). */
  result?: unknown;
  /** Error field (present on error responses). */
  error?: { code: number; message: string };
};

export type MockFetch = {
  fetch: typeof fetch;
  /** All requests the client made, in order. */
  requests: RequestRecord[];
  /** The most recent request for a given JSON-RPC method. */
  lastRequest: (method: string) => RequestRecord | undefined;
  /** Number of times a given JSON-RPC method was requested (for retry counts). */
  callCount: (method: string) => number;
  /** Replace/register a handler for a method. */
  onRequest: (method: string, handler: FakeHandler) => void;
  /**
   * Make the next response for `method` a bare (non-enveloped) JSON body. Used
   * to test the permissive/strict `normalizeHttpEnvelope` paths.
   */
  onRawResponse: (method: string, body: unknown) => void;
  /** Reset recorded requests (keeps handlers). */
  reset: () => void;
};

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {
      return JSON.stringify(body);
    },
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    clone() {
      return this;
    },
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    async text() {
      return JSON.stringify({ error: { code: status, message: 'fake' } });
    },
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    clone() {
      return this;
    },
  } as unknown as Response;
}

/**
 * Build a `fetch` mock for streamable-HTTP transport unit tests.
 *
 * The mock parses each outgoing request body, dispatches to a handler keyed by
 * JSON-RPC method, and returns the handler's result wrapped as a JSON-RPC
 * response. Handlers may return either a plain `result` object (wrapped in
 * `{ jsonrpc: '2.0', id, result }`) or a full JSON-RPC message (used to test the
 * array-envelope / permissive normalization paths).
 */
function sseResponse(
  events: Array<{ id?: number; method: string; params?: unknown }>,
  shouldError: boolean
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (shouldError) {
        // Defer the error to a macrotask so the client has returned from
        // createMcpClientConnection (and the caller assigned its connection
        // handle) before the SSE reader reports the drop. Keeps the
        // stream-error unit test deterministic (no fire-and-forget race).
        setTimeout(() => {
          controller.error(new Error('stream dropped'));
        }, 0);
        return;
      }
      for (const ev of events) {
        const frame: Record<string, unknown> = {
          jsonrpc: '2.0',
          method: ev.method,
          params: ev.params,
        };
        if (ev.id !== undefined) {
          frame.id = ev.id;
        }
        controller.enqueue(
          encoder.encode(`event: message\ndata: ${JSON.stringify(frame)}\n\n`)
        );
      }
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: stream,
    async text() {
      return '';
    },
    redirected: false,
    type: 'basic',
    url: '',
    clone() {
      return this;
    },
  } as unknown as Response;
}

export function createMockFetch(options: MockFetchOptions = {}): MockFetch {
  const pageSize = options.pageSize ?? 1000;
  const tools = options.tools ?? DEFAULT_TOOLS;
  const resources = options.resources ?? DEFAULT_RESOURCES;
  const prompts = options.prompts ?? DEFAULT_PROMPTS;
  const resourceTemplates =
    options.resourceTemplates ?? DEFAULT_RESOURCE_TEMPLATES;
  const implementsShutdown = options.implementsShutdown ?? true;
  const httpErrors = options.httpErrors ?? {};
  // Raw (non-enveloped) HTTP bodies keyed by method.
  const rawBodies = new Map<string, unknown>();

  const handlers: Record<string, FakeHandler> = {
    initialize: () => ({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'fake-mcp', version: '0.0.0' },
    }),
    'tools/list': (params: unknown) => {
      const cursor =
        params && typeof params === 'object' && 'cursor' in (params as object)
          ? (params as { cursor: string }).cursor
          : undefined;
      const start = cursor ? Number(cursor) : 0;
      const slice = tools.slice(start, start + pageSize);
      const next = start + pageSize;
      const hasMore = next < tools.length;
      return {
        tools: slice,
        nextCursor: hasMore ? String(next) : undefined,
      };
    },
    'tools/call': (params: unknown) => {
      const p = (params ?? {}) as { name?: string; arguments?: unknown };
      return {
        content: [
          {
            type: 'text',
            text: `called ${p.name} with ${JSON.stringify(p.arguments ?? {})}`,
          },
        ],
        // NOTE: current client ignores `isError`. The fake can set it; tests
        // assert the client currently does NOT react to it.
        isError: false,
      };
    },
    'resources/list': (params: unknown) => {
      const cursor =
        params && typeof params === 'object' && 'cursor' in (params as object)
          ? (params as { cursor: string }).cursor
          : undefined;
      const start = cursor ? Number(cursor) : 0;
      const slice = resources.slice(start, start + pageSize);
      const next = start + pageSize;
      const hasMore = next < resources.length;
      return {
        resources: slice,
        nextCursor: hasMore ? String(next) : undefined,
      };
    },
    'resources/read': (params: unknown) => {
      const p = (params ?? {}) as { uri?: string };
      return {
        contents: [{ uri: p.uri, text: `contents of ${p.uri}` }],
      };
    },
    'resources/templates/list': (params: unknown) => {
      const cursor =
        params && typeof params === 'object' && 'cursor' in (params as object)
          ? (params as { cursor: string }).cursor
          : undefined;
      const start = cursor ? Number(cursor) : 0;
      const slice = resourceTemplates.slice(start, start + pageSize);
      const next = start + pageSize;
      const hasMore = next < resourceTemplates.length;
      return {
        resourceTemplates: slice,
        nextCursor: hasMore ? String(next) : undefined,
      };
    },
    'prompts/list': (params: unknown) => {
      const cursor =
        params && typeof params === 'object' && 'cursor' in (params as object)
          ? (params as { cursor: string }).cursor
          : undefined;
      const start = cursor ? Number(cursor) : 0;
      const slice = prompts.slice(start, start + pageSize);
      const next = start + pageSize;
      const hasMore = next < prompts.length;
      return {
        prompts: slice,
        nextCursor: hasMore ? String(next) : undefined,
      };
    },
    'prompts/get': (params: unknown) => {
      const p = (params ?? {}) as { name?: string; arguments?: unknown };
      return {
        description: `prompt ${p.name}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `run ${p.name} with ${JSON.stringify(p.arguments ?? {})}`,
            },
          },
        ],
      };
    },
    shutdown: () => {
      if (!implementsShutdown) {
        return {
          jsonrpc: '2.0',
          id: 0,
          error: { code: -32601, message: 'Method not found' },
        };
      }
      return { ok: true };
    },
    ...(options.handlers ?? {}),
  };

  const requests: RequestRecord[] = [];
  const perMethodCount = new Map<string, number>();

  async function handle(
    id: number,
    method: string,
    params: unknown
  ): Promise<unknown> {
    perMethodCount.set(method, (perMethodCount.get(method) ?? 0) + 1);
    if (method === 'initialize' && options.initializeError) {
      return {
        jsonrpc: '2.0',
        id,
        error: options.initializeError,
      };
    }
    const handler = handlers[method];
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    }
    const result = await handler(params);
    // If the handler returned a full JSON-RPC message (has error/result at
    // top level), pass it through for envelope tests.
    if (
      result &&
      typeof result === 'object' &&
      ('result' in result || 'error' in result)
    ) {
      return { jsonrpc: '2.0', id, ...(result as object) };
    }
    return { jsonrpc: '2.0', id, result };
  }

  const fetchCore = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? String(init?.body) : '';
    const parsed = body ? JSON.parse(body) : {};
    // For POST the JSON-RPC method lives in the body; for GET/DELETE there is
    // no body, so record the HTTP verb instead.
    const httpMethod = init?.method ?? 'POST';
    const method = (
      httpMethod === 'POST' ? parsed.method : httpMethod
    ) as string;
    const id = parsed.id as number;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    }
    requests.push({
      method,
      params: parsed.params,
      url,
      headers,
      id: parsed.id,
      result: parsed.result,
      error: parsed.error,
    });

    // GET -> open the server->client SSE stream (point-8 transport).
    if (init?.method === 'GET') {
      const events = options.sseEvents ?? [];
      return sseResponse(events, options.sseError ?? false);
    }

    // DELETE -> best-effort session termination.
    if (init?.method === 'DELETE') {
      if (httpErrors['DELETE']) {
        return errorResponse(httpErrors['DELETE']);
      }
      return {
        ok: true,
        status: 204,
        statusText: 'No Content',
        async text() {
          return '';
        },
        headers: new Headers(),
        redirected: false,
        type: 'basic',
        url: '',
        clone() {
          return this;
        },
      } as unknown as Response;
    }

    if (options.forceHttpError) {
      return errorResponse(options.forceHttpError);
    }

    if (httpErrors[method]) {
      return errorResponse(httpErrors[method]);
    }

    if (rawBodies.has(method)) {
      return okResponse(rawBodies.get(method));
    }

    const signal = init?.signal ?? null;
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const handlerResult = await handle(id, method, parsed.params);
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const resp = okResponse(handlerResult);
    if (method === 'initialize' && options.sessionId) {
      resp.headers.set('mcp-session-id', options.sessionId);
    }
    return resp;
  };

  // Wrap so that an AbortSignal on the RequestInit actually rejects the
  // returned Promise with an AbortError, matching real fetch behavior.
  const fetchImpl = (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        const onAbort = () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        fetchCore(input, init).then(
          response => {
            signal.removeEventListener('abort', onAbort);
            resolve(response);
          },
          error => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          }
        );
      } else {
        void fetchCore(input, init).then(resolve, reject);
      }
    });
  };

  return {
    fetch: fetchImpl,
    requests,
    lastRequest: method => requests.filter(r => r.method === method).at(-1),
    callCount: method => perMethodCount.get(method) ?? 0,
    onRequest: (method, handler) => {
      handlers[method] = handler;
    },
    onRawResponse: (method, body) => {
      rawBodies.set(method, body);
    },
    reset: () => {
      requests.length = 0;
      perMethodCount.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Real stdio child process (slow suite only)
// ---------------------------------------------------------------------------

const SERVER_SCRIPT = path.join(__dirname, 'mcp-fake-server.mjs');

export type FakeMcpServerOptions = {
  /** Tool names to advertise. Defaults to echo/add. */
  toolNames?: string[];
  /** Tool name that triggers a notifications/message on call. */
  notifyMessageOnToolName?: string;
  /** Tool name that triggers a notification on call. */
  notifyOnToolName?: string;
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

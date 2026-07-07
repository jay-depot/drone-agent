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
 * `resources/read`, `prompts/list`, `prompts/get`, and optionally `shutdown`.
 *
 * IMPORTANT (Phase 1): these doubles encode the CLIENT's CURRENT behavior, not
 * the spec-ideal behavior. For example the HTTP fake does not emit an
 * `Mcp-Session-Id` header because the current client never reads/echos it. This
 * is intentional — the tests are the regression net that later fix-phases will
 * update. Do not "fix" the fake to be spec-compliant in a way that diverges from
 * what the current client expects.
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
  /** Whether `shutdown` is implemented (returns -32601 if false). */
  implementsShutdown?: boolean;
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

const DEFAULT_PROMPTS = [
  { name: 'greeting', description: 'A greeting prompt.' },
  { name: 'summarize', description: 'A summarize prompt.' },
];

type RequestRecord = {
  method: string;
  params: unknown;
  url: string;
  headers: Record<string, string>;
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
export function createMockFetch(options: MockFetchOptions = {}): MockFetch {
  const pageSize = options.pageSize ?? 1000;
  const tools = options.tools ?? DEFAULT_TOOLS;
  const resources = options.resources ?? DEFAULT_RESOURCES;
  const prompts = options.prompts ?? DEFAULT_PROMPTS;
  const implementsShutdown = options.implementsShutdown ?? true;
  const httpErrors = options.httpErrors ?? {};
  // Raw (non-enveloped) HTTP bodies keyed by method.
  const rawBodies = new Map<string, unknown>();

  const handlers: Record<string, FakeHandler> = {
    initialize: () => ({
      protocolVersion: '2024-11-05',
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

  function handle(id: number, method: string, params: unknown): unknown {
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
    const result = handler(params);
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

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? String(init?.body) : '';
    const parsed = body ? JSON.parse(body) : {};
    const method = parsed.method as string;
    const id = parsed.id as number;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    }
    requests.push({ method, params: parsed.params, url, headers });

    if (options.forceHttpError) {
      return errorResponse(options.forceHttpError);
    }

    if (httpErrors[method]) {
      return errorResponse(httpErrors[method]);
    }

    if (rawBodies.has(method)) {
      return okResponse(rawBodies.get(method));
    }

    return okResponse(handle(id, method, parsed.params));
  }) as unknown as typeof fetch;

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

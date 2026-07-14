import { isRecord } from '../../shared/type-guards.js';
import type {
  DroneLogger,
  DroneMcpResourceMeta,
  DroneMcpResourceTemplateMeta,
  DroneMcpPromptArgument,
  DroneMcpServerConfig,
  DroneMcpStdioServerConfig,
  DroneMcpServerState,
  DroneMcpPromptMeta,
} from 'drone-core';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const HEADER_SEPARATOR = '\r\n\r\n';

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcClient = {
  request: <T>(method: string, params?: unknown) => Promise<T>;
  notify: (method: string, params?: unknown) => void;
  disconnect: () => void;
  setProtocolVersion: (version: string) => void;
  startNotifications?: () => void;
};

type RpcTransport = {
  write: (payload: string) => void;
  close: () => void;
  onData: (callback: (chunk: Buffer) => void) => void;
  onClose: (callback: (reason: string) => void) => void;
  onError: (callback: (error: Error) => void) => void;
};

export type McpToolMeta = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type ListResult<T> = {
  items: T[];
  truncated: boolean;
};

export type McpClientConnection = {
  serverId: string;
  state: DroneMcpServerState;
  listTools: () => Promise<McpToolMeta[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  listResources: () => Promise<DroneMcpResourceMeta[]>;
  readResource: (uri: string) => Promise<unknown>;
  listPrompts: () => Promise<DroneMcpPromptMeta[]>;
  listResourceTemplates: () => Promise<DroneMcpResourceTemplateMeta[]>;
  getPrompt: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  disconnect: () => Promise<void>;
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractToolErrorText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return '';
  }
  return result.content
    .filter(isRecord)
    .map(c => (typeof c.text === 'string' ? c.text : ''))
    .join('\n')
    .trim();
}

function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }

  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function classifyErrorCategory(
  error: unknown
): DroneMcpServerState['lastErrorCategory'] {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  if (message.includes('timed out')) {
    return 'timeout';
  }
  if (
    message.includes('fetch failed') ||
    message.includes('econn') ||
    message.includes('transport') ||
    message.includes('status')
  ) {
    return 'transport';
  }
  if (message.includes('invalid payload') || message.includes('invalid json')) {
    return 'payload';
  }
  if (message.includes('mcp ') || message.includes('json-rpc')) {
    return 'protocol';
  }
  return 'unknown';
}

function createChildTransport(
  childProcess: ChildProcessWithoutNullStreams
): RpcTransport {
  return {
    write: payload => {
      childProcess.stdin.write(payload);
    },
    close: () => {
      childProcess.stdin.end();
    },
    onData: callback => {
      childProcess.stdout.on('data', callback);
    },
    onClose: callback => {
      childProcess.on('close', (code, signal) => {
        const reason =
          code !== null
            ? `mcp process exited with code ${code}`
            : `mcp process exited with signal ${signal ?? 'unknown'}`;
        callback(reason);
      });
    },
    onError: callback => {
      childProcess.on('error', callback);
      childProcess.stderr.on('data', chunk => {
        const message = chunk.toString('utf8').trim();
        if (message.length > 0) {
          callback(new Error(message));
        }
      });
    },
  };
}

function createStdioJsonRpcClient(options: {
  transport: RpcTransport;
  requestTimeoutMs: number;
  onNotification?: (method: string, params: unknown) => void;
  onTransportIssue: (error: string) => void;
  encoding?: 'content-length' | 'line-delimited';
}): JsonRpcClient {
  if (options.encoding === 'line-delimited') {
    return createLineDelimitedJsonRpcClient(options);
  }
  return createContentLengthJsonRpcClient(options);
}

/**
 * Standard MCP HTTP-style framing: `Content-Length: N\r\n\r\n{payload}`.
 * Compatible with most MCP servers (Claude Code, etc.).
 */
function createContentLengthJsonRpcClient(options: {
  transport: RpcTransport;
  requestTimeoutMs: number;
  onNotification?: (method: string, params: unknown) => void;
  onTransportIssue: (error: string) => void;
}): JsonRpcClient {
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function rejectAll(reason: string): void {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function markClosed(reason: string): void {
    if (closed) {
      return;
    }
    closed = true;
    rejectAll(reason);
    options.onTransportIssue(reason);
  }

  function sendMessage(message: JsonRpcMessage): void {
    if (closed) {
      throw new Error('MCP transport is closed.');
    }

    const payload = JSON.stringify({ jsonrpc: '2.0', ...message });
    options.transport.write(
      `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`
    );
  }

  function parseBuffer(): void {
    while (true) {
      const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) {
        return;
      }

      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const contentLengthLine = header
        .split('\r\n')
        .find(line => line.toLowerCase().startsWith('content-length:'));
      if (!contentLengthLine) {
        markClosed('MCP transport received a message without Content-Length.');
        options.transport.close();
        return;
      }

      const contentLength = Number(contentLengthLine.split(':')[1]?.trim());
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        markClosed('MCP transport received an invalid Content-Length header.');
        options.transport.close();
        return;
      }

      const start = headerEnd + HEADER_SEPARATOR.length;
      const end = start + contentLength;
      if (buffer.length < end) {
        return;
      }

      const raw = buffer.subarray(start, end).toString('utf8');
      buffer = buffer.subarray(end);

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(raw) as JsonRpcMessage;
      } catch {
        markClosed('MCP transport received invalid JSON.');
        options.transport.close();
        return;
      }

      if (typeof message.id === 'number') {
        const entry = pending.get(message.id);
        if (!entry) {
          continue;
        }

        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.error) {
          entry.reject(
            new Error(`MCP ${message.error.code}: ${message.error.message}`)
          );
          continue;
        }
        entry.resolve(message.result);
      } else if (typeof message.method === 'string' && options.onNotification) {
        options.onNotification(message.method, message.params);
      }
    }
  }

  options.transport.onData(chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    parseBuffer();
  });
  options.transport.onError(error => {
    markClosed(error.message);
  });
  options.transport.onClose(reason => {
    markClosed(reason);
  });

  return {
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      if (closed) {
        throw new Error('MCP transport is closed.');
      }

      const id = nextId;
      nextId += 1;

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, options.requestTimeoutMs);

        pending.set(id, {
          resolve: value => resolve(value as T),
          reject,
          timer,
        });

        try {
          sendMessage({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify: (method: string, params?: unknown) => {
      if (closed) {
        return;
      }
      sendMessage({ method, params });
    },
    disconnect: () => {
      markClosed('MCP transport disconnected');
      options.transport.close();
    },
    setProtocolVersion: () => {
      // stdio transport does not use the MCP-Protocol-Version header
    },
  };
}

/**
 * Line-delimited JSON (NDJSON) framing: one JSON object per line, no
 * Content-Length headers. Used by servers like Lightpanda that read stdin
 * line-by-line instead of parsing MCP HTTP-style framing.
 *
 * On the write side, each message is serialized and written as a single
 * line terminated by `\n`. On the read side, incoming data is split on
 * `\n` and each non-empty line is parsed as a complete JSON message.
 */
function createLineDelimitedJsonRpcClient(options: {
  transport: RpcTransport;
  requestTimeoutMs: number;
  onNotification?: (method: string, params: unknown) => void;
  onTransportIssue: (error: string) => void;
}): JsonRpcClient {
  let nextId = 1;
  let buffer = '';
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function rejectAll(reason: string): void {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function markClosed(reason: string): void {
    if (closed) {
      return;
    }
    closed = true;
    rejectAll(reason);
    options.onTransportIssue(reason);
  }

  function sendMessage(message: JsonRpcMessage): void {
    if (closed) {
      throw new Error('MCP transport is closed.');
    }

    const payload = JSON.stringify({ jsonrpc: '2.0', ...message });
    options.transport.write(payload + '\n');
  }

  function parseBuffer(): void {
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        markClosed('MCP transport received invalid JSON.');
        options.transport.close();
        return;
      }

      if (typeof message.id === 'number') {
        const entry = pending.get(message.id);
        if (!entry) {
          continue;
        }

        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.error) {
          entry.reject(
            new Error(`MCP ${message.error.code}: ${message.error.message}`)
          );
          continue;
        }
        entry.resolve(message.result);
      } else if (typeof message.method === 'string' && options.onNotification) {
        options.onNotification(message.method, message.params);
      }
    }
  }

  options.transport.onData(chunk => {
    buffer += chunk.toString('utf8');
    parseBuffer();
  });
  options.transport.onError(error => {
    markClosed(error.message);
  });
  options.transport.onClose(reason => {
    markClosed(reason);
  });

  return {
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      if (closed) {
        throw new Error('MCP transport is closed.');
      }

      const id = nextId;
      nextId += 1;

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, options.requestTimeoutMs);

        pending.set(id, {
          resolve: value => resolve(value as T),
          reject,
          timer,
        });

        try {
          sendMessage({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify: (method: string, params?: unknown) => {
      if (closed) {
        return;
      }
      sendMessage({ method, params });
    },
    disconnect: () => {
      markClosed('MCP transport disconnected');
      options.transport.close();
    },
    setProtocolVersion: () => {
      // stdio transport does not use the MCP-Protocol-Version header
    },
  };
}

/**
 * Parse an SSE stream response and extract the first JSON-RPC message with
 * the matching id. Used when a POST request returns text/event-stream instead
 * of application/json (per MCP 2025-06-18 spec, servers may respond either way).
 */
async function parseSseResponse(
  response: Response,
  id: number
): Promise<JsonRpcMessage> {
  if (!response.body) {
    throw new Error('SSE response has no body stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Look for a data: line containing a JSON-RPC message with our id
    const match = buffer.match(/^data:\s*(\{.*?\})\s*$/m);
    if (match) {
      try {
        return JSON.parse(match[1]) as JsonRpcMessage;
      } catch {
        /* continue reading */
      }
    }
  }
  throw new Error('Invalid JSON payload from streamable HTTP MCP server.');
}

function normalizeHttpEnvelope(
  input: unknown,
  id: number,
  compatibilityMode: 'strict' | 'permissive'
): JsonRpcMessage {
  const payload = Array.isArray(input)
    ? (input.find(item => isRecord(item) && item.id === id) ??
      input.find(item => isRecord(item)))
    : input;

  if (!isRecord(payload)) {
    throw new Error('Invalid payload from streamable HTTP MCP server.');
  }

  if ('result' in payload || 'error' in payload) {
    return payload as JsonRpcMessage;
  }

  if (compatibilityMode === 'permissive') {
    return {
      jsonrpc: '2.0',
      id,
      result: payload,
    };
  }

  throw new Error('Invalid JSON-RPC envelope from streamable HTTP MCP server.');
}

/**
 * Streamable HTTP MCP transport.
 *
 * Uses POST for all requests (with optional streaming via `?accept` param)
 * and a long-lived GET SSE stream for server-to-client notifications.
 *
 * The GET stream is automatically reconnected on transient drops with
 * exponential backoff (1s, 2s, 4s, ..., capped at 60s).
 */
function createStreamableHttpJsonRpcClient(options: {
  serverId: string;
  url: string;
  headers: Record<string, string>;
  requestTimeoutMs: number;
  compatibilityMode: 'strict' | 'permissive';
  onNotification: (method: string, params: unknown) => void;
  onStreamError: (message: string) => void;
  onStreamReconnected?: () => void;
}): JsonRpcClient {
  let nextId = 1;
  let closed = false;
  let sessionId: string | undefined;
  let negotiatedProtocolVersion = '2025-06-18';

  async function openGetStream(): Promise<void> {
    let backoffMs = 1000;
    while (!closed) {
      try {
        const response = await fetch(options.url, {
          method: 'GET',
          headers: {
            accept: 'text/event-stream',
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
            'MCP-Protocol-Version': negotiatedProtocolVersion,
            ...options.headers,
          },
          signal: AbortSignal.timeout(options.requestTimeoutMs),
        });

        if (!response.ok || !response.body) {
          options.onStreamError(
            `GET stream returned ${response.status} ${response.statusText}`
          );
          // 405 Method Not Allowed means the server does not offer an SSE
          // stream at this endpoint (per MCP 2025-06-18 spec). Stop retrying.
          if (response.status === 405) {
            return;
          }
          if (!closed) {
            await sleep(backoffMs);
            backoffMs = Math.min(backoffMs * 2, 60000);
          }
          continue;
        }

        // Successfully opened — reset backoff and mark streaming
        backoffMs = 1000;
        options.onStreamReconnected?.();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!closed) {
          const { done, value } = await reader.read();
          if (done) {
            // Stream ended normally (server closed it)
            if (!closed) {
              await sleep(1000); // brief pause before retry
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          let separator: number;
          while ((separator = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const dataLine = rawEvent
              .split('\n')
              .find(line => line.startsWith('data:'));
            if (!dataLine) {
              continue;
            }
            const data = dataLine.slice('data:'.length).trim();
            if (data.length === 0) {
              continue;
            }
            try {
              const message = JSON.parse(data) as JsonRpcMessage;
              if (typeof message.method === 'string') {
                options.onNotification(message.method, message.params);
              }
            } catch {
              // Ignore malformed SSE payloads.
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }
        options.onStreamError(
          error instanceof Error ? error.message : String(error)
        );
        if (!closed) {
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 60000);
        }
      }
    }
  }

  return {
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      if (closed) {
        throw new Error('MCP HTTP client is closed.');
      }

      const id = nextId;
      nextId += 1;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        options.requestTimeoutMs
      );

      try {
        const response = await fetch(options.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': negotiatedProtocolVersion,
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
            ...options.headers,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            `MCP HTTP ${options.serverId} returned ${response.status} ${response.statusText}`
          );
        }

        const serverSessionId = response.headers.get('mcp-session-id');
        if (serverSessionId) {
          sessionId = serverSessionId;
        }

        const contentType = response.headers.get('content-type') ?? '';
        const isSse = contentType.includes('text/event-stream');
        let parsedBody: unknown;
        if (isSse) {
          const sseMessage = await parseSseResponse(response, id);
          parsedBody = sseMessage;
        } else {
          const rawBody = await response.text();
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            throw new Error(
              'Invalid JSON payload from streamable HTTP MCP server.'
            );
          }
        }

        const payload = normalizeHttpEnvelope(
          parsedBody,
          id,
          options.compatibilityMode
        );
        if (payload.error) {
          throw new Error(
            `MCP ${payload.error.code}: ${payload.error.message}`
          );
        }

        return payload.result as T;
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          throw new Error(`MCP request timed out: ${method}`, { cause: error });
        }
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timer);
      }
    },
    notify: () => {
      // Streamable HTTP uses request-response calls in this runtime.
    },
    startNotifications: () => {
      // Fire-and-forget: open the server->client SSE channel.
      void openGetStream();
    },
    setProtocolVersion: (version: string) => {
      negotiatedProtocolVersion = version;
    },
    disconnect: () => {
      closed = true;
      // Best-effort DELETE to terminate the session server-side. Non-blocking
      // so disconnect() keeps its synchronous signature; failures are logged
      // via onStreamError but never throw.
      void fetch(options.url, {
        method: 'DELETE',
        headers: {
          'MCP-Protocol-Version': negotiatedProtocolVersion,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...options.headers,
        },
      })
        .then(response => {
          if (!response.ok) {
            options.onStreamError(
              `DELETE failed: ${response.status} ${response.statusText}`
            );
          }
        })
        .catch(error => {
          options.onStreamError(
            `DELETE failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    },
  };
}

function parseNextCursor(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  if (typeof result.nextCursor === 'string' && result.nextCursor.length > 0) {
    return result.nextCursor;
  }
  if (typeof result.cursor === 'string' && result.cursor.length > 0) {
    return result.cursor;
  }

  return undefined;
}

function normalizeTools(result: unknown): McpToolMeta[] {
  if (!isRecord(result)) {
    return [];
  }

  const tools: McpToolMeta[] = [];
  for (const tool of asArray(result.tools)) {
    if (!isRecord(tool) || typeof tool.name !== 'string') {
      continue;
    }
    tools.push({
      name: tool.name,
      description:
        typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: tool.inputSchema,
    });
  }

  return tools;
}

function normalizeResources(result: unknown): DroneMcpResourceMeta[] {
  if (!isRecord(result)) {
    return [];
  }

  const resources: DroneMcpResourceMeta[] = [];
  for (const resource of asArray(result.resources)) {
    if (!isRecord(resource) || typeof resource.uri !== 'string') {
      continue;
    }
    resources.push({
      uri: resource.uri,
      name: typeof resource.name === 'string' ? resource.name : undefined,
      description:
        typeof resource.description === 'string'
          ? resource.description
          : undefined,
      mimeType:
        typeof resource.mimeType === 'string' ? resource.mimeType : undefined,
    });
  }

  return resources;
}

function normalizeResourceTemplateArguments(
  value: unknown
): DroneMcpPromptArgument[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const args: DroneMcpPromptArgument[] = [];
  for (const arg of value) {
    if (!isRecord(arg) || typeof arg.name !== 'string') {
      continue;
    }
    args.push({
      name: arg.name,
      required: typeof arg.required === 'boolean' ? arg.required : undefined,
      description:
        typeof arg.description === 'string' ? arg.description : undefined,
    });
  }
  return args.length > 0 ? args : undefined;
}

function normalizeResourceTemplates(
  result: unknown
): DroneMcpResourceTemplateMeta[] {
  if (!isRecord(result)) {
    return [];
  }

  const templates: DroneMcpResourceTemplateMeta[] = [];
  for (const template of asArray(result.resourceTemplates)) {
    if (!isRecord(template) || typeof template.uriTemplate !== 'string') {
      continue;
    }
    templates.push({
      uriTemplate: template.uriTemplate,
      name: typeof template.name === 'string' ? template.name : undefined,
      description:
        typeof template.description === 'string'
          ? template.description
          : undefined,
      mimeType:
        typeof template.mimeType === 'string' ? template.mimeType : undefined,
      arguments: normalizeResourceTemplateArguments(template.arguments),
    });
  }

  return templates;
}

function normalizePrompts(result: unknown): DroneMcpPromptMeta[] {
  if (!isRecord(result)) {
    return [];
  }

  const prompts: DroneMcpPromptMeta[] = [];
  for (const prompt of asArray(result.prompts)) {
    if (!isRecord(prompt) || typeof prompt.name !== 'string') {
      continue;
    }

    const argumentsList: NonNullable<DroneMcpPromptMeta['arguments']> = [];
    for (const argument of asArray(prompt.arguments)) {
      if (!isRecord(argument) || typeof argument.name !== 'string') {
        continue;
      }
      argumentsList.push({
        name: argument.name,
        required:
          typeof argument.required === 'boolean'
            ? argument.required
            : undefined,
        description:
          typeof argument.description === 'string'
            ? argument.description
            : undefined,
      });
    }

    prompts.push({
      name: prompt.name,
      description:
        typeof prompt.description === 'string' ? prompt.description : undefined,
      arguments: argumentsList,
    });
  }

  return prompts;
}

export async function createMcpClientConnection(options: {
  serverId: string;
  config: DroneMcpServerConfig;
  defaultRequestTimeoutMs: number;
  defaultRetryCount: number;
  defaultRetryDelayMs: number;
  defaultMaxListPages: number;
  defaultMaxListItems: number;
  defaultCompatibilityMode: 'strict' | 'permissive';
  onNotification: (method: string, params: unknown) => void;
  onStreamError: (message: string) => void;
  logger: DroneLogger;
  /** Fires after a successful reconnection (SSE stream reconnect or stdio child respawn). */
  onReconnected?: () => void;
}): Promise<McpClientConnection> {
  const effectiveRequestTimeoutMs =
    options.config.requestTimeoutMs ?? options.defaultRequestTimeoutMs;
  const effectiveRetryCount =
    options.config.retryCount ?? options.defaultRetryCount;
  const effectiveRetryDelayMs =
    options.config.retryDelayMs ?? options.defaultRetryDelayMs;
  const effectiveMaxListPages =
    options.config.maxListPages ?? options.defaultMaxListPages;
  const effectiveMaxListItems =
    options.config.maxListItems ?? options.defaultMaxListItems;
  const effectiveCompatibilityMode =
    options.config.transport === 'streamable_http'
      ? (options.config.compatibilityMode ?? options.defaultCompatibilityMode)
      : options.defaultCompatibilityMode;

  const state: DroneMcpServerState = {
    id: options.serverId,
    transport:
      options.config.transport === 'streamable_http'
        ? 'streamable_http'
        : 'stdio',
    ownership:
      options.config.transport === 'streamable_http' ? 'external' : 'spawned',
    status: 'connecting',
    detail:
      options.config.transport === 'streamable_http'
        ? options.config.url
        : `${options.config.command}${
            options.config.args && options.config.args.length > 0
              ? ` ${options.config.args.join(' ')}`
              : ''
          }`,
    discoveredToolCount: 0,
    mountedToolCount: 0,
    filteredToolCount: 0,
    compatibilityMode:
      options.config.transport === 'streamable_http'
        ? effectiveCompatibilityMode
        : undefined,
    retryCount: effectiveRetryCount,
    retryAttemptCount: 0,
  };

  let childProcess: ChildProcessWithoutNullStreams | undefined;
  let closed = false;
  let rpc: JsonRpcClient;

  if (options.config.transport === 'streamable_http') {
    rpc = createStreamableHttpJsonRpcClient({
      serverId: options.serverId,
      url: options.config.url,
      headers: options.config.headers ?? {},
      requestTimeoutMs: effectiveRequestTimeoutMs,
      compatibilityMode: effectiveCompatibilityMode,
      onNotification: options.onNotification,
      onStreamError: options.onStreamError,
      onStreamReconnected: options.onReconnected,
    });
  } else {
    const stdioConfig = options.config as DroneMcpStdioServerConfig;
    childProcess = spawn(stdioConfig.command, stdioConfig.args ?? [], {
      cwd: stdioConfig.cwd,
      env: {
        ...process.env,
        ...(stdioConfig.env ?? {}),
      },
      stdio: 'pipe',
    });

    rpc = createStdioJsonRpcClient({
      transport: createChildTransport(childProcess),
      requestTimeoutMs: effectiveRequestTimeoutMs,
      onTransportIssue: error => {
        state.status = 'error';
        state.lastError = error;
        state.lastErrorCategory = classifyErrorCategory(error);
      },
      encoding: stdioConfig.encoding,
      onNotification: options.onNotification,
    });
  }

  async function requestWithRetry<T>(
    method: string,
    params: unknown,
    idempotent: boolean
  ): Promise<T> {
    const maxAttempts = idempotent ? Math.max(1, effectiveRetryCount + 1) : 1;
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      try {
        return await rpc.request<T>(method, params);
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt >= maxAttempts) {
          break;
        }
        state.retryAttemptCount += 1;
        await sleep(effectiveRetryDelayMs);
      }
    }

    state.lastError =
      lastError instanceof Error ? lastError.message : String(lastError);
    state.lastErrorCategory = classifyErrorCategory(lastError);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function paginateList<T>(
    method: string,
    normalize: (result: unknown) => T[]
  ): Promise<ListResult<T>> {
    const items: T[] = [];
    let cursor: string | undefined;
    let page = 0;
    let truncated = false;
    const seenCursors = new Set<string>();

    while (
      page < effectiveMaxListPages &&
      items.length < effectiveMaxListItems
    ) {
      const params = cursor ? { cursor } : {};
      const result = await requestWithRetry<unknown>(method, params, true);
      const pageItems = normalize(result);
      const remaining = effectiveMaxListItems - items.length;
      items.push(...pageItems.slice(0, Math.max(0, remaining)));

      const nextCursor = parseNextCursor(result);
      if (!nextCursor) {
        break;
      }
      if (seenCursors.has(nextCursor)) {
        truncated = true;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      page += 1;
    }

    if (
      cursor &&
      (page >= effectiveMaxListPages || items.length >= effectiveMaxListItems)
    ) {
      truncated = true;
    }

    return { items, truncated };
  }

  async function walkAllPages<T>(
    method: string,
    normalize: (result: unknown) => T[]
  ): Promise<ListResult<T>> {
    const items: T[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    while (true) {
      const params = cursor ? { cursor } : {};
      const result = await requestWithRetry<unknown>(method, params, true);
      const pageItems = normalize(result);
      items.push(...pageItems);

      const nextCursor = parseNextCursor(result);
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) break; // infinite-loop protection
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return { items, truncated: false };
  }

  function startRespawnMonitor(): void {
    const stdioConfig = options.config as DroneMcpStdioServerConfig;
    let backoffMs = 1000;
    const monitor = async () => {
      while (!closed) {
        if (state.status !== 'error') {
          await sleep(200);
          continue;
        }
        try {
          const newChild = spawn(stdioConfig.command, stdioConfig.args ?? [], {
            cwd: stdioConfig.cwd,
            env: {
              ...process.env,
              ...(stdioConfig.env ?? {}),
            },
            stdio: 'pipe',
          });
          const newRpc = createStdioJsonRpcClient({
            transport: createChildTransport(newChild),
            requestTimeoutMs: effectiveRequestTimeoutMs,
            onTransportIssue: error => {
              state.status = 'error';
              state.lastError = error;
              state.lastErrorCategory = classifyErrorCategory(error);
            },
            encoding: stdioConfig.encoding,
            onNotification: options.onNotification,
          });
          await newRpc.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            clientInfo: { name: 'drone-agent', version: '0.1.0' },
          });
          newRpc.notify('notifications/initialized', {});
          childProcess = newChild;
          rpc = newRpc;
          state.status = 'connected';
          state.lastError = undefined;
          state.lastErrorCategory = undefined;
          backoffMs = 1000;
          options.onReconnected?.();
          state.reconnectCount = (state.reconnectCount ?? 0) + 1;
        } catch (error) {
          state.lastError =
            error instanceof Error ? error.message : String(error);
          state.lastErrorCategory = classifyErrorCategory(error);
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 60000);
        }
      }
    };
    void monitor();
  }

  try {
    const initResult = await requestWithRetry<{ protocolVersion?: string }>(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        clientInfo: {
          name: 'drone-agent',
          version: '0.1.0',
        },
      },
      false
    );
    rpc.notify('notifications/initialized', {});
    // Extract the negotiated protocol version from the server's response
    if (initResult?.protocolVersion) {
      rpc.setProtocolVersion(initResult.protocolVersion);
    }
    state.status = 'connected';
    state.lastError = undefined;
    state.lastErrorCategory = undefined;
    if (options.config.transport === 'streamable_http') {
      rpc.startNotifications?.();
      state.streaming = true;
    }
    if (state.ownership === 'spawned') {
      startRespawnMonitor();
    }
    options.onReconnected?.();
  } catch (error) {
    state.status = 'error';
    state.lastError = error instanceof Error ? error.message : String(error);
    state.lastErrorCategory = classifyErrorCategory(error);
    rpc.disconnect();
    if (childProcess) {
      childProcess.kill();
    }
    throw error;
  }

  return {
    serverId: options.serverId,
    state,
    listTools: async () => {
      const toolsResult = await walkAllPages('tools/list', normalizeTools);
      state.toolsListTruncated = false;
      state.discoveredToolCount = toolsResult.items.length;
      return toolsResult.items;
    },
    callTool: async (name, args) => {
      const result = await requestWithRetry<unknown>(
        'tools/call',
        { name, arguments: args },
        false
      );
      if (isRecord(result) && result.isError === true) {
        const text = extractToolErrorText(result);
        throw new Error(`MCP tool '${name}' failed${text ? `: ${text}` : ''}`);
      }
      return result;
    },
    listResources: async () => {
      const resourcesResult = await paginateList(
        'resources/list',
        normalizeResources
      );
      state.resourcesListTruncated = resourcesResult.truncated;
      return resourcesResult.items;
    },
    readResource: async uri => {
      return requestWithRetry<unknown>(
        'resources/read',
        {
          uri,
        },
        true
      );
    },
    listPrompts: async () => {
      const promptsResult = await paginateList(
        'prompts/list',
        normalizePrompts
      );
      state.promptsListTruncated = promptsResult.truncated;
      return promptsResult.items;
    },
    listResourceTemplates: async () => {
      const templatesResult = await paginateList(
        'resources/templates/list',
        normalizeResourceTemplates
      );
      state.resourceTemplatesListTruncated = templatesResult.truncated;
      return templatesResult.items;
    },
    getPrompt: async (name, args) => {
      return requestWithRetry<unknown>(
        'prompts/get',
        {
          name,
          arguments: args,
        },
        true
      );
    },
    disconnect: async () => {
      // Attempt graceful shutdown for spawned servers
      closed = true;
      if (state.ownership === 'spawned' && state.status === 'connected') {
        try {
          await requestWithRetry('shutdown', {}, false);
        } catch (error) {
          // Method not found (-32601) is expected for servers like Lightpanda
          // that don't implement the optional shutdown method
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          if (
            errorMessage.includes('-32601') ||
            errorMessage.includes('Method not found')
          ) {
            // Gracefully ignore - server may not implement shutdown
          } else {
            options.logger.warn(
              `mcp server ${options.serverId} shutdown request failed: ${errorMessage}`
            );
          }
        }

        // Send exit notification (required by MCP spec for graceful server termination)
        try {
          rpc.notify('exit');
        } catch {
          // Ignore notification failures during teardown
        }
      }

      // Disconnect RPC transport
      rpc.disconnect();

      // Forcefully terminate spawned process after timeout if it hasn't exited
      if (state.ownership === 'spawned' && childProcess) {
        const cp = childProcess;
        const FORCE_KILL_DELAY_MS = 2500;
        const exitPromise = new Promise<void>(resolve => {
          const onExit = () => resolve();
          cp.once('exit', onExit);
          // Also resolve if process is already dead
          if (!cp.pid || cp.killed) {
            resolve();
          }
        });

        const timeoutPromise = new Promise<void>(resolve => {
          setTimeout(() => {
            options.logger.warn(
              `mcp server ${options.serverId} did not exit gracefully, forcing termination`
            );
            cp.kill();
            resolve();
          }, FORCE_KILL_DELAY_MS);
        });

        await Promise.race([exitPromise, timeoutPromise]);
      }

      state.status = 'disconnected';
    },
  };
}

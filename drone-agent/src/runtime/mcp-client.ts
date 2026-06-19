import type {
  DroneLogger,
  DroneMcpResourceMeta,
  DroneMcpServerConfig,
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
  getPrompt: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  disconnect: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
  };
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

function createStreamableHttpJsonRpcClient(options: {
  serverId: string;
  url: string;
  headers: Record<string, string>;
  requestTimeoutMs: number;
  compatibilityMode: 'strict' | 'permissive';
}): JsonRpcClient {
  let nextId = 1;
  let closed = false;

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
            accept: 'application/json',
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

        const rawBody = await response.text();
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          throw new Error(
            'Invalid JSON payload from streamable HTTP MCP server.'
          );
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
    disconnect: () => {
      closed = true;
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
  logger: DroneLogger;
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
  let rpc: JsonRpcClient;

  if (options.config.transport === 'streamable_http') {
    rpc = createStreamableHttpJsonRpcClient({
      serverId: options.serverId,
      url: options.config.url,
      headers: options.config.headers ?? {},
      requestTimeoutMs: effectiveRequestTimeoutMs,
      compatibilityMode: effectiveCompatibilityMode,
    });
  } else {
    childProcess = spawn(options.config.command, options.config.args ?? [], {
      cwd: options.config.cwd,
      env: {
        ...process.env,
        ...(options.config.env ?? {}),
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

  try {
    await requestWithRetry(
      'initialize',
      {
        protocolVersion: '2024-11-05',
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
    state.status = 'connected';
    state.lastError = undefined;
    state.lastErrorCategory = undefined;
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
      const toolsResult = await paginateList('tools/list', normalizeTools);
      state.toolsListTruncated = toolsResult.truncated;
      state.discoveredToolCount = toolsResult.items.length;
      return toolsResult.items;
    },
    callTool: async (name, args) => {
      return requestWithRetry<unknown>(
        'tools/call',
        {
          name,
          arguments: args,
        },
        false
      );
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
      try {
        if (state.ownership === 'spawned' && state.status === 'connected') {
          await requestWithRetry('shutdown', {}, false);
        }
      } catch (error) {
        options.logger.warn(
          `mcp server ${options.serverId} shutdown request failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        rpc.disconnect();
        if (state.ownership === 'spawned') {
          childProcess?.kill();
        }
        state.status = 'disconnected';
      }
    },
  };
}

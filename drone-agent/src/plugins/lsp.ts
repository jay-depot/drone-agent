import type {
  DroneLspDiagnostic,
  DroneLspHoverResult,
  DroneLspServerConfig,
  DroneLspServerState,
  DronePlugin,
} from 'drone-core';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HEADER_SEPARATOR = '\r\n\r\n';
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.drone-agent',
  'dist',
  'build',
  'coverage',
  'node_modules',
]);
const MAX_DOCUMENT_BYTES = 256 * 1024;

type JsonRpcId = number;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};

type RpcTransport = {
  write: (payload: string) => void;
  close: () => void;
  onData: (callback: (chunk: Buffer) => void) => void;
  onClose: (callback: (reason: string) => void) => void;
  onError: (callback: (error: Error) => void) => void;
};

type JsonRpcClient = {
  request: <T>(method: string, params?: unknown) => Promise<T>;
  notify: (method: string, params?: unknown) => void;
  disconnect: (reason?: string) => void;
};

type KnownServerSpec = {
  id: string;
  language: string;
  command: string;
  args: string[];
  fileExtensions: string[];
  rootPatterns: string[];
};

type DocumentState = {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  mtimeMs: number;
  size: number;
};

type ServerRuntime = {
  id: string;
  language: string;
  transport: 'stdio' | 'tcp';
  ownership: 'spawned' | 'external';
  detail: string;
  fileExtensions: string[];
  client: JsonRpcClient;
  state: DroneLspServerState;
  documents: Map<string, DocumentState>;
  childProcess?: ChildProcessWithoutNullStreams;
  socket?: Socket;
};

type HoverResponse = {
  contents?: unknown;
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
} | null;

type LspRangeResponse = {
  start?: { line?: number; character?: number };
  end?: { line?: number; character?: number };
};

type LspLocationResponse = {
  uri?: string;
  range?: LspRangeResponse;
};

type LspLocationLinkResponse = {
  targetUri?: string;
  targetRange?: LspRangeResponse;
  targetSelectionRange?: LspRangeResponse;
  originSelectionRange?: LspRangeResponse;
};

type DefinitionResponse =
  | LspLocationResponse
  | LspLocationResponse[]
  | LspLocationLinkResponse[]
  | null;

type ReferencesResponse = LspLocationResponse[] | null;

type PublishDiagnosticsParams = {
  uri?: string;
  diagnostics?: Array<{
    range?: {
      start?: { line?: number; character?: number };
      end?: { line?: number; character?: number };
    };
    severity?: number;
    message?: string;
    source?: string;
    code?: string | number;
  }>;
};

const KNOWN_SERVER_SPECS: KnownServerSpec[] = [
  {
    id: 'typescript',
    language: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    fileExtensions: [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mts',
      '.cts',
      '.mjs',
      '.cjs',
    ],
    rootPatterns: ['tsconfig.json', 'jsconfig.json', 'package.json'],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFileExtensions(fileExtensions: string[]): string[] {
  return Array.from(
    new Set(
      fileExtensions.map(extension =>
        extension.startsWith('.')
          ? extension.toLowerCase()
          : `.${extension.toLowerCase()}`
      )
    )
  );
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
            ? `child process exited with code ${code}`
            : `child process exited with signal ${signal ?? 'unknown'}`;
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

function createSocketTransport(socket: Socket): RpcTransport {
  return {
    write: payload => {
      socket.write(payload);
    },
    close: () => {
      socket.end();
    },
    onData: callback => {
      socket.on('data', callback);
    },
    onClose: callback => {
      socket.on('close', hadError => {
        callback(
          hadError ? 'socket closed after transport error' : 'socket closed'
        );
      });
    },
    onError: callback => {
      socket.on('error', callback);
    },
  };
}

function createJsonRpcClient(options: {
  transport: RpcTransport;
  requestTimeoutMs: number;
  onNotification: (method: string, params: unknown) => void;
  onTransportIssue: (message: string) => void;
}): JsonRpcClient {
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let closed = false;
  const pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function rejectPending(reason: string): void {
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
    rejectPending(reason);
    options.onTransportIssue(reason);
  }

  function sendMessage(message: JsonRpcMessage): void {
    if (closed) {
      throw new Error('LSP transport is closed.');
    }

    const payload = JSON.stringify({ jsonrpc: '2.0', ...message });
    options.transport.write(
      `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`
    );
  }

  function tryParseMessages(): void {
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
        markClosed('LSP transport received a message without Content-Length.');
        options.transport.close();
        return;
      }

      const contentLengthValue = contentLengthLine.split(':')[1]?.trim();
      const contentLength = Number(contentLengthValue);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        markClosed('LSP transport received an invalid Content-Length header.');
        options.transport.close();
        return;
      }

      const messageStart = headerEnd + HEADER_SEPARATOR.length;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }

      const payload = buffer
        .subarray(messageStart, messageEnd)
        .toString('utf8');
      buffer = buffer.subarray(messageEnd);

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(payload) as JsonRpcMessage;
      } catch {
        markClosed('LSP transport received invalid JSON.');
        options.transport.close();
        return;
      }

      if (typeof message.method === 'string' && message.id === undefined) {
        options.onNotification(message.method, message.params);
        continue;
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
            new Error(`LSP ${message.error.code}: ${message.error.message}`)
          );
          continue;
        }

        entry.resolve(message.result);
      }
    }
  }

  options.transport.onData(chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    tryParseMessages();
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
        throw new Error('LSP transport is closed.');
      }

      const id = nextId;
      nextId += 1;

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`LSP request timed out: ${method}`));
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
    disconnect: (reason = 'transport closed') => {
      markClosed(reason);
      options.transport.close();
    },
  };
}

function normalizeSeverity(
  severity: number | undefined
): DroneLspDiagnostic['severity'] {
  switch (severity) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'information';
    default:
      return 'hint';
  }
}

function normalizeHoverContents(contents: unknown): string {
  if (typeof contents === 'string') {
    return contents;
  }

  if (Array.isArray(contents)) {
    return contents.map(normalizeHoverContents).filter(Boolean).join('\n\n');
  }

  if (isRecord(contents)) {
    if (typeof contents.value === 'string') {
      return contents.value;
    }
    if (
      typeof contents.language === 'string' &&
      typeof contents.value === 'string'
    ) {
      return `Language: ${contents.language}\n${contents.value}`;
    }
  }

  return '';
}

function toFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

function fromFileUri(uri: string): string | null {
  try {
    return path.resolve(fileURLToPath(uri));
  } catch {
    return null;
  }
}

function normalizeLspRange(range: LspRangeResponse | undefined): {
  start: { line: number; character: number };
  end: { line: number; character: number };
} {
  return {
    start: {
      line: range?.start?.line ?? 0,
      character: range?.start?.character ?? 0,
    },
    end: {
      line: range?.end?.line ?? range?.start?.line ?? 0,
      character: range?.end?.character ?? range?.start?.character ?? 0,
    },
  };
}

function normalizeLspLocation(
  location: LspLocationResponse | LspLocationLinkResponse
): {
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
} | null {
  const isLocationLink =
    'targetUri' in location ||
    'targetRange' in location ||
    'targetSelectionRange' in location;
  const uri = isLocationLink
    ? (location as LspLocationLinkResponse).targetUri
    : (location as LspLocationResponse).uri;
  if (typeof uri !== 'string') {
    return null;
  }

  const filePath = fromFileUri(uri);
  if (!filePath) {
    return null;
  }

  const range = isLocationLink
    ? ((location as LspLocationLinkResponse).targetSelectionRange ??
      (location as LspLocationLinkResponse).targetRange)
    : (location as LspLocationResponse).range;

  const normalizedRange = normalizeLspRange(range);
  return {
    filePath,
    range: normalizedRange,
  };
}

function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 1;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

function sortDiagnostics(
  diagnostics: DroneLspDiagnostic[]
): DroneLspDiagnostic[] {
  const severityRank: Record<DroneLspDiagnostic['severity'], number> = {
    error: 0,
    warning: 1,
    information: 2,
    hint: 3,
  };

  return [...diagnostics].sort((left, right) => {
    const severityDiff =
      severityRank[left.severity] - severityRank[right.severity];
    if (severityDiff !== 0) {
      return severityDiff;
    }
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    if (left.range.start.line !== right.range.start.line) {
      return left.range.start.line - right.range.start.line;
    }
    return left.range.start.character - right.range.start.character;
  });
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function workspaceHasMarkers(
  rootPath: string,
  markers: string[]
): Promise<boolean> {
  for (const marker of markers) {
    if (await pathExists(path.join(rootPath, marker))) {
      return true;
    }
  }

  return false;
}

async function collectWorkspaceFiles(
  rootPath: string,
  fileExtensions: string[]
): Promise<string[]> {
  const normalizedExtensions = normalizeFileExtensions(fileExtensions);
  const matches: string[] = [];

  async function visitDirectory(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        await visitDirectory(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (normalizedExtensions.includes(extension)) {
        matches.push(entryPath);
      }
    }
  }

  await visitDirectory(rootPath);
  return matches.sort((left, right) => left.localeCompare(right));
}

function getKnownServerSpec(language: string): KnownServerSpec | undefined {
  return KNOWN_SERVER_SPECS.find(
    spec => spec.language === language || spec.id === language
  );
}

function resolveLanguageId(filePath: string, fallbackLanguage: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'javascriptreact';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'typescriptreact';
    default:
      return fallbackLanguage;
  }
}

function formatServerDetail(config: DroneLspServerConfig): string {
  if (config.transport === 'tcp') {
    return `${config.host}:${config.port}`;
  }

  const args =
    config.args && config.args.length > 0 ? ` ${config.args.join(' ')}` : '';
  return `${config.command}${args}`;
}

async function connectTcpServer(
  config: Extract<DroneLspServerConfig, { transport: 'tcp' }>,
  timeoutMs: number
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: config.host, port: config.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(`Timed out connecting to ${config.host}:${config.port}`)
      );
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function readDocumentSnapshot(filePath: string): Promise<{
  text: string;
  mtimeMs: number;
  size: number;
} | null> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size > MAX_DOCUMENT_BYTES) {
    return null;
  }

  const text = await readFile(filePath, 'utf8');
  return {
    text,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  };
}

export const lspPlugin: DronePlugin = {
  metadata: {
    id: 'lsp',
    name: 'LSP',
    version: '0.1.0',
    description:
      'Adds lightweight language-server diagnostics and semantic queries.',
    defaultEnabled: false,
  },
  register: async registration => {
    const workspaceRoot = process.cwd();
    const lspConfig = registration.getConfig().lsp;
    const diagnosticsByFile = new Map<string, DroneLspDiagnostic[]>();
    const serverRuntimes = new Map<string, ServerRuntime>();
    let workspaceDirty = true;

    function updateServerState(
      serverId: string,
      update: Partial<DroneLspServerState>
    ): void {
      const runtime = serverRuntimes.get(serverId);
      if (!runtime) {
        return;
      }
      runtime.state = {
        ...runtime.state,
        ...update,
      };
    }

    function getAllDiagnostics(): DroneLspDiagnostic[] {
      return sortDiagnostics(Array.from(diagnosticsByFile.values()).flat());
    }

    function renderDiagnosticsPrompt(): string | false {
      const diagnostics = getAllDiagnostics().filter(
        item => item.severity === 'error' || item.severity === 'warning'
      );
      if (diagnostics.length === 0) {
        return false;
      }

      const budget = Math.max(1, lspConfig.diagnosticTokenBudget);
      const lines: string[] = [];
      let usedTokens = 0;

      for (const diagnostic of diagnostics) {
        const relativePath =
          path.relative(workspaceRoot, diagnostic.filePath) ||
          diagnostic.filePath;
        const codePrefix = diagnostic.code ? `${diagnostic.code} ` : '';
        const line = `${relativePath}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.severity.toUpperCase()} ${codePrefix}${diagnostic.message}`;
        const tokens = estimateTokenCount(line);
        if (usedTokens + tokens > budget) {
          lines.push('... additional diagnostics omitted');
          break;
        }
        usedTokens += tokens;
        lines.push(line);
      }

      return `Current LSP diagnostics:\n${lines.join('\n')}`;
    }

    function handlePublishDiagnostics(params: unknown): void {
      const value = params as PublishDiagnosticsParams;
      if (!value?.uri || !Array.isArray(value.diagnostics)) {
        return;
      }

      const filePath = fromFileUri(value.uri);
      if (!filePath) {
        return;
      }

      const normalized: DroneLspDiagnostic[] = value.diagnostics
        .filter(
          diagnostic =>
            typeof diagnostic.message === 'string' && diagnostic.range
        )
        .map(diagnostic => ({
          filePath,
          range: {
            start: {
              line: diagnostic.range?.start?.line ?? 0,
              character: diagnostic.range?.start?.character ?? 0,
            },
            end: {
              line:
                diagnostic.range?.end?.line ??
                diagnostic.range?.start?.line ??
                0,
              character:
                diagnostic.range?.end?.character ??
                diagnostic.range?.start?.character ??
                0,
            },
          },
          severity: normalizeSeverity(diagnostic.severity),
          message: diagnostic.message ?? '',
          source: diagnostic.source,
          code:
            typeof diagnostic.code === 'string' ||
            typeof diagnostic.code === 'number'
              ? String(diagnostic.code)
              : undefined,
        }));

      diagnosticsByFile.set(filePath, normalized);
    }

    async function initializeClient(runtime: ServerRuntime): Promise<void> {
      updateServerState(runtime.id, {
        status: 'connecting',
        detail: runtime.detail,
        lastError: undefined,
      });

      await runtime.client.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(workspaceRoot).href,
        capabilities: {
          textDocument: {
            publishDiagnostics: {
              relatedInformation: false,
            },
            hover: {
              contentFormat: ['markdown', 'plaintext'],
            },
            textDocumentSync: {
              didSave: false,
              willSave: false,
              willSaveWaitUntil: false,
            },
          },
        },
        workspaceFolders: [
          {
            uri: pathToFileURL(workspaceRoot).href,
            name: path.basename(workspaceRoot),
          },
        ],
      });
      runtime.client.notify('initialized', {});
      updateServerState(runtime.id, {
        status: 'connected',
        detail: runtime.detail,
        lastError: undefined,
      });
    }

    async function createRuntimeFromConfig(
      serverId: string,
      language: string,
      config: DroneLspServerConfig
    ): Promise<ServerRuntime> {
      const knownSpec = getKnownServerSpec(language);
      const fileExtensions = normalizeFileExtensions(
        config.fileExtensions ?? knownSpec?.fileExtensions ?? []
      );
      const state: DroneLspServerState = {
        id: serverId,
        language,
        transport: config.transport === 'tcp' ? 'tcp' : 'stdio',
        ownership: config.transport === 'tcp' ? 'external' : 'spawned',
        status: 'connecting',
        detail: formatServerDetail(config),
      };

      if (config.transport === 'tcp') {
        const socket = await connectTcpServer(
          config,
          lspConfig.requestTimeoutMs
        );
        const client = createJsonRpcClient({
          transport: createSocketTransport(socket),
          requestTimeoutMs: lspConfig.requestTimeoutMs,
          onNotification: (method, params) => {
            if (method === 'textDocument/publishDiagnostics') {
              handlePublishDiagnostics(params);
            }
          },
          onTransportIssue: message => {
            updateServerState(serverId, {
              status: 'error',
              lastError: message,
            });
          },
        });

        return {
          id: serverId,
          language,
          transport: 'tcp',
          ownership: 'external',
          detail: state.detail,
          fileExtensions,
          client,
          state,
          documents: new Map(),
          socket,
        };
      }

      const childProcess = spawn(config.command, config.args ?? [], {
        cwd: workspaceRoot,
        env: process.env,
        stdio: 'pipe',
      });
      const client = createJsonRpcClient({
        transport: createChildTransport(childProcess),
        requestTimeoutMs: lspConfig.requestTimeoutMs,
        onNotification: (method, params) => {
          if (method === 'textDocument/publishDiagnostics') {
            handlePublishDiagnostics(params);
          }
        },
        onTransportIssue: message => {
          updateServerState(serverId, {
            status: 'error',
            lastError: message,
          });
        },
      });

      return {
        id: serverId,
        language,
        transport: 'stdio',
        ownership: 'spawned',
        detail: state.detail,
        fileExtensions,
        client,
        state,
        documents: new Map(),
        childProcess,
      };
    }

    async function detectKnownLanguageSpecs(): Promise<KnownServerSpec[]> {
      const matches: KnownServerSpec[] = [];
      for (const spec of KNOWN_SERVER_SPECS) {
        if (await workspaceHasMarkers(workspaceRoot, spec.rootPatterns)) {
          matches.push(spec);
        }
      }
      return matches;
    }

    async function resolveConfiguredRuntimes(): Promise<
      Array<{
        serverId: string;
        language: string;
        config: DroneLspServerConfig;
      }>
    > {
      const resolved: Array<{
        serverId: string;
        language: string;
        config: DroneLspServerConfig;
      }> = [];
      for (const [serverId, serverConfig] of Object.entries(
        lspConfig.servers
      )) {
        const language = serverConfig.language ?? serverId;
        resolved.push({
          serverId,
          language,
          config: serverConfig,
        });
      }
      return resolved;
    }

    async function initializeServers(): Promise<void> {
      const configuredRuntimes = await resolveConfiguredRuntimes();
      const configuredByLanguage = new Map<
        string,
        Array<(typeof configuredRuntimes)[number]>
      >();
      for (const runtime of configuredRuntimes) {
        const current = configuredByLanguage.get(runtime.language) ?? [];
        current.push(runtime);
        configuredByLanguage.set(runtime.language, current);
      }

      const knownSpecs = await detectKnownLanguageSpecs();
      const selected: Array<{
        serverId: string;
        language: string;
        config: DroneLspServerConfig;
      }> = [];
      const languages = new Set<string>([
        ...configuredByLanguage.keys(),
        ...knownSpecs.map(spec => spec.language),
      ]);

      for (const language of languages) {
        const configured = configuredByLanguage.get(language) ?? [];
        if (configured.length > 0) {
          if (lspConfig.preferExternal) {
            const external = configured.find(
              item => item.config.transport === 'tcp'
            );
            if (external) {
              selected.push(external);
              continue;
            }
          }
          selected.push(configured[0]);
          continue;
        }

        const knownSpec = knownSpecs.find(spec => spec.language === language);
        if (!knownSpec) {
          continue;
        }

        selected.push({
          serverId: knownSpec.id,
          language: knownSpec.language,
          config: {
            transport: 'stdio',
            language: knownSpec.language,
            command: knownSpec.command,
            args: knownSpec.args,
            fileExtensions: knownSpec.fileExtensions,
            rootPatterns: knownSpec.rootPatterns,
          },
        });
      }

      for (const candidate of selected) {
        try {
          const runtime = await createRuntimeFromConfig(
            candidate.serverId,
            candidate.language,
            candidate.config
          );
          serverRuntimes.set(runtime.id, runtime);
          await initializeClient(runtime);
          registration.logger.info(
            `lsp server ready: ${runtime.id} (${runtime.ownership}, ${runtime.detail})`
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          registration.logger.warn(
            `lsp server unavailable: ${candidate.serverId} (${message})`
          );
          serverRuntimes.set(candidate.serverId, {
            id: candidate.serverId,
            language: candidate.language,
            transport: candidate.config.transport === 'tcp' ? 'tcp' : 'stdio',
            ownership:
              candidate.config.transport === 'tcp' ? 'external' : 'spawned',
            detail: formatServerDetail(candidate.config),
            fileExtensions: normalizeFileExtensions(
              candidate.config.fileExtensions ??
                getKnownServerSpec(candidate.language)?.fileExtensions ??
                []
            ),
            client: createJsonRpcClient({
              transport: {
                write: () => undefined,
                close: () => undefined,
                onData: () => undefined,
                onClose: () => undefined,
                onError: () => undefined,
              },
              requestTimeoutMs: lspConfig.requestTimeoutMs,
              onNotification: () => undefined,
              onTransportIssue: () => undefined,
            }),
            state: {
              id: candidate.serverId,
              language: candidate.language,
              transport: candidate.config.transport === 'tcp' ? 'tcp' : 'stdio',
              ownership:
                candidate.config.transport === 'tcp' ? 'external' : 'spawned',
              status: 'error',
              detail: formatServerDetail(candidate.config),
              lastError: message,
            },
            documents: new Map(),
          });
        }
      }
    }

    async function syncServerDocuments(runtime: ServerRuntime): Promise<void> {
      if (runtime.state.status !== 'connected') {
        return;
      }

      const matchingFiles = await collectWorkspaceFiles(
        workspaceRoot,
        runtime.fileExtensions
      );
      const nextFiles = new Set(
        matchingFiles.map(filePath => path.resolve(filePath))
      );

      for (const filePath of matchingFiles) {
        const absolutePath = path.resolve(filePath);
        let snapshot: Awaited<ReturnType<typeof readDocumentSnapshot>>;
        try {
          snapshot = await readDocumentSnapshot(absolutePath);
        } catch {
          continue;
        }
        if (!snapshot) {
          continue;
        }

        const existing = runtime.documents.get(absolutePath);
        if (
          existing &&
          existing.mtimeMs === snapshot.mtimeMs &&
          existing.size === snapshot.size
        ) {
          continue;
        }

        const uri = toFileUri(absolutePath);
        const languageId = resolveLanguageId(absolutePath, runtime.language);
        if (!existing) {
          runtime.client.notify('textDocument/didOpen', {
            textDocument: {
              uri,
              languageId,
              version: 1,
              text: snapshot.text,
            },
          });
          runtime.documents.set(absolutePath, {
            uri,
            languageId,
            version: 1,
            text: snapshot.text,
            mtimeMs: snapshot.mtimeMs,
            size: snapshot.size,
          });
          continue;
        }

        const nextVersion = existing.version + 1;
        runtime.client.notify('textDocument/didChange', {
          textDocument: {
            uri,
            version: nextVersion,
          },
          contentChanges: [{ text: snapshot.text }],
        });
        runtime.documents.set(absolutePath, {
          ...existing,
          version: nextVersion,
          text: snapshot.text,
          mtimeMs: snapshot.mtimeMs,
          size: snapshot.size,
        });
      }

      for (const filePath of Array.from(runtime.documents.keys())) {
        if (nextFiles.has(filePath)) {
          continue;
        }

        const existing = runtime.documents.get(filePath);
        if (!existing) {
          continue;
        }
        runtime.client.notify('textDocument/didClose', {
          textDocument: {
            uri: existing.uri,
          },
        });
        runtime.documents.delete(filePath);
        diagnosticsByFile.delete(filePath);
      }
    }

    async function refreshWorkspaceIfNeeded(): Promise<void> {
      if (!workspaceDirty) {
        return;
      }

      for (const runtime of serverRuntimes.values()) {
        await syncServerDocuments(runtime);
      }

      workspaceDirty = false;
    }

    function resolveTargetFilePath(inputPath: string): string {
      return path.resolve(workspaceRoot, inputPath);
    }

    function parsePositionInput(
      toolName: string,
      input: Record<string, unknown>
    ): { filePath: string; line: number; column: number } {
      if (
        typeof input.filePath !== 'string' ||
        input.filePath.trim().length === 0
      ) {
        throw new Error(`${toolName} requires a non-empty filePath string.`);
      }
      if (
        typeof input.line !== 'number' ||
        !Number.isInteger(input.line) ||
        input.line <= 0
      ) {
        throw new Error(`${toolName} line must be a positive integer.`);
      }
      if (
        typeof input.column !== 'number' ||
        !Number.isInteger(input.column) ||
        input.column <= 0
      ) {
        throw new Error(`${toolName} column must be a positive integer.`);
      }

      return {
        filePath: resolveTargetFilePath(input.filePath),
        line: input.line,
        column: input.column,
      };
    }

    function findRuntimeForFile(filePath: string): ServerRuntime | undefined {
      const extension = path.extname(filePath).toLowerCase();
      for (const runtime of serverRuntimes.values()) {
        if (
          runtime.state.status === 'connected' &&
          runtime.fileExtensions.includes(extension)
        ) {
          return runtime;
        }
      }
      return undefined;
    }

    async function ensureDocumentLoaded(
      runtime: ServerRuntime,
      filePath: string
    ): Promise<DocumentState> {
      await syncServerDocuments(runtime);
      const absolutePath = path.resolve(filePath);
      const existing = runtime.documents.get(absolutePath);
      if (existing) {
        return existing;
      }

      const snapshot = await readDocumentSnapshot(absolutePath);
      if (!snapshot) {
        throw new Error(`Could not load LSP document: ${absolutePath}`);
      }

      const documentState: DocumentState = {
        uri: toFileUri(absolutePath),
        languageId: resolveLanguageId(absolutePath, runtime.language),
        version: 1,
        text: snapshot.text,
        mtimeMs: snapshot.mtimeMs,
        size: snapshot.size,
      };
      runtime.client.notify('textDocument/didOpen', {
        textDocument: {
          uri: documentState.uri,
          languageId: documentState.languageId,
          version: documentState.version,
          text: documentState.text,
        },
      });
      runtime.documents.set(absolutePath, documentState);
      return documentState;
    }

    registration.registerPromptFragment({
      key: 'diagnostics',
      phase: 'header',
      render: async () => renderDiagnosticsPrompt(),
    });

    registration.registerTool({
      name: 'get_diagnostics',
      description:
        'Return the current LSP diagnostics for the workspace or a specific file.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description:
              'Optional file path to filter diagnostics to a specific file.',
          },
          severity: {
            type: 'string',
            description:
              'Optional severity filter: error, warning, information, hint, or all.',
          },
        },
        additionalProperties: false,
      },
      execute: async input => {
        await refreshWorkspaceIfNeeded();
        const severity =
          typeof input.severity === 'string'
            ? input.severity.toLowerCase()
            : 'all';
        if (
          !['all', 'error', 'warning', 'information', 'hint'].includes(severity)
        ) {
          throw new Error(
            'lsp.get_diagnostics severity must be one of: all, error, warning, information, hint.'
          );
        }

        const filePath =
          typeof input.filePath === 'string'
            ? resolveTargetFilePath(input.filePath)
            : undefined;
        const diagnostics = getAllDiagnostics().filter(diagnostic => {
          if (filePath && diagnostic.filePath !== filePath) {
            return false;
          }
          if (severity !== 'all' && diagnostic.severity !== severity) {
            return false;
          }
          return true;
        });

        return JSON.stringify(
          {
            diagnostics,
            serverStates: Array.from(serverRuntimes.values()).map(
              runtime => runtime.state
            ),
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'hover',
      description:
        'Return LSP hover information for a symbol at a file, line, and column.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Workspace-relative or absolute file path.',
          },
          line: {
            type: 'integer',
            description: '1-based line number.',
          },
          column: {
            type: 'integer',
            description: '1-based column number.',
          },
        },
        required: ['filePath', 'line', 'column'],
        additionalProperties: false,
      },
      execute: async input => {
        await refreshWorkspaceIfNeeded();
        const { filePath, line, column } = parsePositionInput(
          'lsp.hover',
          input
        );
        const runtime = findRuntimeForFile(filePath);
        if (!runtime) {
          throw new Error(
            `No connected LSP server is available for ${filePath}.`
          );
        }

        const document = await ensureDocumentLoaded(runtime, filePath);
        const response = await runtime.client.request<HoverResponse>(
          'textDocument/hover',
          {
            textDocument: {
              uri: document.uri,
            },
            position: {
              line: line - 1,
              character: column - 1,
            },
          }
        );
        const contents = normalizeHoverContents(response?.contents);
        const result: DroneLspHoverResult = {
          filePath,
          line,
          column,
          contents,
          range: response?.range
            ? normalizeLspRange(response.range)
            : undefined,
        };

        return JSON.stringify(result, null, 2);
      },
    });

    registration.registerTool({
      name: 'go_to_definition',
      description:
        'Resolve the definition location(s) for a symbol at a file, line, and column.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Workspace-relative or absolute file path.',
          },
          line: {
            type: 'integer',
            description: '1-based line number.',
          },
          column: {
            type: 'integer',
            description: '1-based column number.',
          },
        },
        required: ['filePath', 'line', 'column'],
        additionalProperties: false,
      },
      execute: async input => {
        await refreshWorkspaceIfNeeded();
        const { filePath, line, column } = parsePositionInput(
          'lsp.go_to_definition',
          input
        );
        const runtime = findRuntimeForFile(filePath);
        if (!runtime) {
          throw new Error(
            `No connected LSP server is available for ${filePath}.`
          );
        }

        const document = await ensureDocumentLoaded(runtime, filePath);
        const definition = await runtime.client.request<DefinitionResponse>(
          'textDocument/definition',
          {
            textDocument: {
              uri: document.uri,
            },
            position: {
              line: line - 1,
              character: column - 1,
            },
          }
        );

        const rawLocations = Array.isArray(definition)
          ? definition
          : definition
            ? [definition]
            : [];
        const locations = rawLocations
          .map(location => normalizeLspLocation(location))
          .filter((location): location is NonNullable<typeof location> =>
            Boolean(location)
          );

        return JSON.stringify(
          {
            query: {
              filePath,
              line,
              column,
            },
            locations: locations.map(location => ({
              filePath: location.filePath,
              line: location.range.start.line + 1,
              column: location.range.start.character + 1,
              range: location.range,
            })),
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'find_references',
      description:
        'Find references to a symbol at a file, line, and column, optionally excluding declarations.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Workspace-relative or absolute file path.',
          },
          line: {
            type: 'integer',
            description: '1-based line number.',
          },
          column: {
            type: 'integer',
            description: '1-based column number.',
          },
          includeDeclaration: {
            type: 'boolean',
            description:
              'Whether declaration sites should be included in the results. Defaults to true.',
          },
        },
        required: ['filePath', 'line', 'column'],
        additionalProperties: false,
      },
      execute: async input => {
        await refreshWorkspaceIfNeeded();
        const { filePath, line, column } = parsePositionInput(
          'lsp.find_references',
          input
        );
        const includeDeclaration =
          typeof input.includeDeclaration === 'boolean'
            ? input.includeDeclaration
            : true;

        const runtime = findRuntimeForFile(filePath);
        if (!runtime) {
          throw new Error(
            `No connected LSP server is available for ${filePath}.`
          );
        }

        const document = await ensureDocumentLoaded(runtime, filePath);
        const references = await runtime.client.request<ReferencesResponse>(
          'textDocument/references',
          {
            textDocument: {
              uri: document.uri,
            },
            position: {
              line: line - 1,
              character: column - 1,
            },
            context: {
              includeDeclaration,
            },
          }
        );

        const locations = (references ?? [])
          .map(location => normalizeLspLocation(location))
          .filter((location): location is NonNullable<typeof location> =>
            Boolean(location)
          );

        return JSON.stringify(
          {
            query: {
              filePath,
              line,
              column,
              includeDeclaration,
            },
            locations: locations.map(location => ({
              filePath: location.filePath,
              line: location.range.start.line + 1,
              column: location.range.start.character + 1,
              range: location.range,
            })),
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'server_status',
      description: 'List LSP server connection state for this session.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      execute: async () =>
        JSON.stringify(
          {
            servers: Array.from(serverRuntimes.values()).map(
              runtime => runtime.state
            ),
          },
          null,
          2
        ),
    });

    registration.hooks.onPluginsLoaded(async () => {
      if (!lspConfig.enabled) {
        registration.logger.info('lsp runtime disabled by config');
        return;
      }

      await initializeServers();
      workspaceDirty = true;
      if (
        Array.from(serverRuntimes.values()).every(
          runtime => runtime.state.status !== 'connected'
        )
      ) {
        registration.logger.warn('no LSP servers connected for this session');
      }
    });

    registration.hooks.onBeforePrompt(async () => {
      if (!lspConfig.enabled) {
        return;
      }
      await refreshWorkspaceIfNeeded();
    });

    registration.hooks.onAfterToolCall(async () => {
      if (!lspConfig.enabled) {
        return;
      }
      workspaceDirty = true;
    });

    registration.hooks.onShutdown(async () => {
      for (const runtime of serverRuntimes.values()) {
        if (
          runtime.ownership === 'spawned' &&
          runtime.state.status === 'connected'
        ) {
          try {
            await runtime.client.request('shutdown');
          } catch {
            // Ignore shutdown request failures during teardown.
          }
          try {
            runtime.client.notify('exit');
          } catch {
            // Ignore exit notification failures during teardown.
          }
        }

        runtime.client.disconnect('plugin shutdown');
        if (runtime.ownership === 'spawned') {
          runtime.childProcess?.kill();
        }
        updateServerState(runtime.id, {
          status: 'disconnected',
        });
      }
    });
  },
};

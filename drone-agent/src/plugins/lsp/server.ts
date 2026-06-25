import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type {
  DroneLspConfig,
  DroneLspDiagnostic,
  DroneLspServerConfig,
  DroneLspServerState,
  DroneLogger,
} from 'drone-core';
import {
  commandExistsOnPath,
  computeCacheKey,
  ensureServerInstalled,
  resolveCacheDir,
  type InstallerResolution,
  type InstallerSpec,
} from './installer.js';
import {
  createChildTransport,
  createJsonRpcClient,
  createSocketTransport,
  type JsonRpcClient,
} from './transport.js';
import {
  fromFileUri,
  normalizeFileExtensions,
  normalizeSeverity,
  toFileUri,
} from './normalize.js';
import {
  resolveLanguageId,
  formatServerDetail,
  getKnownServerSpec,
  KNOWN_SERVER_SPECS,
  type KnownServerSpec,
} from './known-servers.js';

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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

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

type ResolvedSpawn = {
  command: string;
  args: string[];
  source: InstallerResolution['source'];
  installStatus: DroneLspServerState['installStatus'];
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ResolvedPosition = {
  runtime: ServerRuntime;
  document: DocumentState;
  line: number;
  column: number;
};

export type ServerManager = {
  initialize: () => Promise<void>;
  refreshIfNeeded: () => Promise<void>;
  markDirty: () => void;
  getDiagnostics: () => DroneLspDiagnostic[];
  getServerStates: () => DroneLspServerState[];
  renderDiagnosticsPrompt: () => string | false;
  findRuntimeForFile: (filePath: string) => ServerRuntime | undefined;
  ensureDocumentLoaded: (
    runtime: ServerRuntime,
    filePath: string
  ) => Promise<DocumentState>;
  resolveTargetFilePath: (inputPath: string) => string;
  parsePositionInput: (
    toolName: string,
    input: Record<string, unknown>
  ) => { filePath: string; line: number; column: number };
  resolveAtPosition: (
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<ResolvedPosition>;
  locationToAgentShape: (
    locations: Array<{
      filePath: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
  ) => Array<{
    filePath: string;
    line: number;
    column: number;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }>;
  shutdown: () => Promise<void>;
};

type CreateServerManagerOptions = {
  workspaceRoot: string;
  lspConfig: DroneLspConfig;
  logger: DroneLogger;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createServerManager(
  options: CreateServerManagerOptions
): ServerManager {
  const { workspaceRoot, lspConfig, logger } = options;
  const diagnosticsByFile = new Map<string, DroneLspDiagnostic[]>();
  const serverRuntimes = new Map<string, ServerRuntime>();
  let workspaceDirty = true;

  // ── Internal helpers ──────────────────────────────────────────────

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
        diagnostic => typeof diagnostic.message === 'string' && diagnostic.range
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
              diagnostic.range?.end?.line ?? diagnostic.range?.start?.line ?? 0,
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
    config: DroneLspServerConfig,
    resolved: { command: string; args: string[] } | null
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
      const socket = await connectTcpServer(config, lspConfig.requestTimeoutMs);
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

    if (!resolved) {
      throw new Error(
        `No executable command resolved for ${serverId} (command: ${config.command}).`
      );
    }

    const childProcess = spawn(resolved.command, resolved.args, {
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
    for (const [serverId, serverConfig] of Object.entries(lspConfig.servers)) {
      const language = serverConfig.language ?? serverId;
      resolved.push({
        serverId,
        language,
        config: serverConfig,
      });
    }
    return resolved;
  }

  async function resolveServerCommand(
    serverId: string,
    language: string,
    config: DroneLspServerConfig,
    knownSpec: KnownServerSpec | undefined
  ): Promise<ResolvedSpawn | null> {
    // External (TCP) servers are user-managed — nothing to resolve.
    if (config.transport === 'tcp') {
      return null;
    }

    const userAutoInstall =
      config.transport === 'stdio' && config.autoInstall !== undefined
        ? config.autoInstall
        : undefined;
    const autoInstall = userAutoInstall ?? lspConfig.autoInstall;

    // 1. If the user's command resolves on PATH, use it as-is.
    if (await commandExistsOnPath(config.command)) {
      return {
        command: config.command,
        args: config.args ?? [],
        source: 'path',
        installStatus: 'unused',
      };
    }

    // 2. No PATH hit. Try auto-install if enabled and we have install metadata.
    const installSpec =
      knownSpec?.install ??
      (config.transport === 'stdio' && config.command === knownSpec?.command
        ? knownSpec?.install
        : undefined);

    if (!autoInstall || !installSpec) {
      throw new Error(
        `${config.command} not found on PATH and auto-install is disabled.`
      );
    }

    const installerSpec: InstallerSpec = {
      id: serverId,
      command: config.command,
      args: config.args ?? [],
      install: installSpec,
    };

    const wasCached = await (async () => {
      const cacheRoot = resolveCacheDir();
      const cacheKey = computeCacheKey({
        serverId,
        version: installSpec.version,
      });
      const cacheDir = path.join(
        cacheRoot,
        serverId,
        installSpec.version,
        cacheKey
      );
      const entry = path.join(cacheDir, installSpec.nodeEntry);
      try {
        await access(entry, fsConstants.R_OK);
        return true;
      } catch {
        return false;
      }
    })();

    const resolution = await ensureServerInstalled(installerSpec, {
      logger,
    });

    return {
      command: resolution.command,
      args: resolution.args,
      source: resolution.source,
      installStatus: wasCached ? 'cached' : 'downloaded',
    };
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
      knownSpec?: KnownServerSpec;
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
            selected.push({ ...external, knownSpec: undefined });
            continue;
          }
        }
        selected.push({
          ...configured[0],
          knownSpec: getKnownServerSpec(language),
        });
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
        knownSpec,
      });
    }

    for (const candidate of selected) {
      let resolved: ResolvedSpawn | null = null;
      let installStatus: DroneLspServerState['installStatus'] = 'unused';

      try {
        resolved = await resolveServerCommand(
          candidate.serverId,
          candidate.language,
          candidate.config,
          candidate.knownSpec
        );
        installStatus = resolved?.installStatus ?? 'unused';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
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
              candidate.knownSpec?.fileExtensions ??
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
            installSource: 'path',
            installStatus: 'failed',
          },
          documents: new Map(),
        });
        continue;
      }

      try {
        const runtime = await createRuntimeFromConfig(
          candidate.serverId,
          candidate.language,
          candidate.config,
          resolved ? { command: resolved.command, args: resolved.args } : null
        );
        // Surface install provenance on the runtime state.
        if (resolved) {
          updateServerState(runtime.id, {
            installSource: resolved.source,
            installStatus,
          });
        }
        serverRuntimes.set(runtime.id, runtime);
        await initializeClient(runtime);
        logger.info(
          `lsp server ready: ${runtime.id} (${runtime.ownership}, ${runtime.detail}, install=${installStatus})`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
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
              candidate.knownSpec?.fileExtensions ??
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
            installSource: resolved?.source ?? 'path',
            installStatus: resolved ? 'failed' : 'failed',
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

  // ── Inner functions (used by public API and by each other) ──────

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
      filePath: path.resolve(workspaceRoot, input.filePath),
      line: input.line,
      column: input.column,
    };
  }

  async function resolveAtPosition(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ResolvedPosition> {
    const { filePath, line, column } = parsePositionInput(toolName, input);
    const runtime = findRuntimeForFile(filePath);
    if (!runtime) {
      throw new Error(`No connected LSP server is available for ${filePath}.`);
    }
    const document = await ensureDocumentLoaded(runtime, filePath);
    return { runtime, document, line, column };
  }

  // ── Public API ────────────────────────────────────────────────────

  return {
    initialize: async () => {
      await initializeServers();
      workspaceDirty = true;
    },

    refreshIfNeeded: async () => {
      if (!workspaceDirty) {
        return;
      }

      for (const runtime of serverRuntimes.values()) {
        await syncServerDocuments(runtime);
      }

      workspaceDirty = false;
    },

    markDirty: () => {
      workspaceDirty = true;
    },

    getDiagnostics: () => getAllDiagnostics(),

    getServerStates: () =>
      Array.from(serverRuntimes.values()).map(runtime => runtime.state),

    renderDiagnosticsPrompt: () => {
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
    },

    findRuntimeForFile,
    ensureDocumentLoaded,

    resolveTargetFilePath: (inputPath: string) => {
      return path.resolve(workspaceRoot, inputPath);
    },

    parsePositionInput,
    resolveAtPosition,

    locationToAgentShape: (
      locations: Array<{
        filePath: string;
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      }>
    ) => {
      return locations.map(location => ({
        filePath: location.filePath,
        line: location.range.start.line + 1,
        column: location.range.start.character + 1,
        range: location.range,
      }));
    },

    shutdown: async () => {
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
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level helpers (no closure state needed)
// ---------------------------------------------------------------------------

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

// Re-export the PublishDiagnosticsParams type locally since it's used by handlePublishDiagnostics
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

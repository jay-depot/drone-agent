import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { type Socket } from 'node:net';
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
} from './normalize/index.js';
import {
  resolveLanguageId,
  formatServerDetail,
  getKnownServerSpec,
  KNOWN_SERVER_SPECS,
  type KnownServerSpec,
} from './known-servers.js';
import {
  pathExists,
  workspaceHasMarkers,
  collectWorkspaceFiles,
  connectTcpServer,
  readDocumentSnapshot,
  estimateTokenCount,
  sortDiagnostics,
  type PublishDiagnosticsParams,
} from './server/helpers.js';
import {
  flattenDocumentSymbols,
  normalizeWorkspaceSymbols,
  type LspDocumentSymbolResponse,
  type LspWorkspaceSymbolResponse,
  type NormalizedSymbol,
} from './normalize/index.js';

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
  ) => Promise<{ filePath: string; line: number; column: number }>;
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
    _language: string,
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

  /**
   * Sync a single file from disk if it has changed since the last sync.
   * This ensures that if the LLM wrote to a file via file__write in the
   * same turn, the LSP server sees the latest content.
   */
  async function syncFileIfNeeded(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);
    const runtime = findRuntimeForFile(absolutePath);
    if (!runtime) return;

    const snapshot = await readDocumentSnapshot(absolutePath);
    if (!snapshot) return;

    const existing = runtime.documents.get(absolutePath);
    if (!existing) {
      // File not yet open — will be opened by ensureDocumentLoaded
      return;
    }

    if (
      existing.mtimeMs === snapshot.mtimeMs &&
      existing.size === snapshot.size
    ) {
      return; // No change
    }

    const nextVersion = existing.version + 1;
    runtime.client.notify('textDocument/didChange', {
      textDocument: { uri: existing.uri, version: nextVersion },
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

  /**
   * Search file content for a text snippet and return its 1-based position.
   *
   * 1. Exact match (case-sensitive) first
   * 2. Fall back to case-insensitive if no exact match
   * 3. If exactly one match, return `{ line, column }` (1-based)
   * 4. If multiple matches, throw with each position + 2 lines of context
   * 5. If no matches, throw
   */
  async function resolveTextPosition(
    filePath: string,
    text: string
  ): Promise<{ line: number; column: number }> {
    const absolutePath = path.resolve(filePath);
    const snapshot = await readDocumentSnapshot(absolutePath);
    if (!snapshot) {
      throw new Error(`Could not read file: ${absolutePath}`);
    }

    const lines = snapshot.text.split('\n');
    const matches: Array<{
      line: number;
      column: number;
      context: string;
    }> = [];

    // Case-sensitive search
    for (let i = 0; i < lines.length; i++) {
      const col = lines[i].indexOf(text);
      if (col !== -1) {
        const contextLines = lines.slice(
          Math.max(0, i - 2),
          Math.min(lines.length, i + 3)
        );
        matches.push({
          line: i + 1,
          column: col + 1,
          context: contextLines.join('\n'),
        });
      }
    }

    // Fall back to case-insensitive if no exact matches
    if (matches.length === 0) {
      const lowerText = text.toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        const col = lines[i].toLowerCase().indexOf(lowerText);
        if (col !== -1) {
          const contextLines = lines.slice(
            Math.max(0, i - 2),
            Math.min(lines.length, i + 3)
          );
          matches.push({
            line: i + 1,
            column: col + 1,
            context: contextLines.join('\n'),
          });
        }
      }
    }

    if (matches.length === 0) {
      throw new Error(`Text "${text}" not found in ${absolutePath}.`);
    }

    if (matches.length > 1) {
      const details = matches
        .map(
          (m, idx) =>
            `  ${idx + 1}. Line ${m.line}, column ${m.column}:\n${m.context
              .split('\n')
              .map(l => `     ${l}`)
              .join('\n')}`
        )
        .join('\n');
      throw new Error(
        `Text "${text}" is ambiguous — found ${matches.length} matches in ${absolutePath}:\n${details}`
      );
    }

    return { line: matches[0].line, column: matches[0].column };
  }

  /**
   * Search for a symbol by name and return its 1-based position.
   *
   * 1. Try `textDocument/documentSymbol` on the file's runtime
   * 2. Search for exact name match, fall back to prefix match
   * 3. Filter out symbols without position info
   * 4. If no match, try `workspace/symbol` on the runtime
   * 5. If exactly one match, return `{ line, column }` (1-based)
   * 6. If multiple matches, throw with context
   * 7. If no matches, throw
   */
  async function resolveSymbolPosition(
    filePath: string,
    symbol: string
  ): Promise<{ line: number; column: number }> {
    const absolutePath = path.resolve(filePath);
    const runtime = findRuntimeForFile(absolutePath);
    if (!runtime) {
      throw new Error(
        `No connected LSP server is available for ${absolutePath}.`
      );
    }

    const document = await ensureDocumentLoaded(runtime, absolutePath);

    // Try document symbols first
    const docSymbols =
      await runtime.client.request<LspDocumentSymbolResponse[]>(
        'textDocument/documentSymbol',
        { textDocument: { uri: document.uri } }
      );
    const flat = flattenDocumentSymbols(docSymbols);
    const exact = flat.filter(s => s.name === symbol);
    const candidates =
      exact.length > 0
        ? exact
        : flat.filter(s => s.name.startsWith(symbol));

    // Filter out symbols without position info
    const withPosition = candidates.filter(
      (s): s is NormalizedSymbol & { line: number; column: number } =>
        s.line !== undefined && s.column !== undefined
    );

    if (withPosition.length === 1) {
      return { line: withPosition[0].line, column: withPosition[0].column };
    }

    if (withPosition.length > 1) {
      const details = withPosition
        .map(
          (s, idx) =>
            `  ${idx + 1}. Line ${s.line}, column ${s.column} — ${s.name}`
        )
        .join('\n');
      throw new Error(
        `Symbol "${symbol}" is ambiguous — found ${withPosition.length} matches in ${absolutePath}:\n${details}`
      );
    }

    // Fall back to workspace symbol
    const wsSymbols =
      await runtime.client.request<LspWorkspaceSymbolResponse[]>(
        'workspace/symbol',
        { query: symbol }
      );
    const wsFlat = normalizeWorkspaceSymbols(wsSymbols);
    const wsExact = wsFlat.filter(s => s.name === symbol);
    const wsCandidates =
      wsExact.length > 0
        ? wsExact
        : wsFlat.filter(s => s.name.startsWith(symbol));

    // Filter out workspace symbols without position info
    const wsWithPosition = wsCandidates.filter(
      (s): s is NormalizedSymbol & { line: number; column: number } =>
        s.line !== undefined && s.column !== undefined
    );

    if (wsWithPosition.length === 0) {
      throw new Error(`Symbol "${symbol}" not found in workspace.`);
    }

    if (wsWithPosition.length === 1) {
      return {
        line: wsWithPosition[0].line,
        column: wsWithPosition[0].column,
      };
    }

    // Multiple workspace matches
    const details = wsWithPosition
      .map(
        (s, idx) =>
          `  ${idx + 1}. ${s.filePath}:${s.line}:${s.column} — ${s.name}`
      )
      .join('\n');
    throw new Error(
      `Symbol "${symbol}" is ambiguous across the workspace — found ${wsWithPosition.length} matches:\n${details}`
    );
  }

  /**
   * Parse position input from a tool call. Accepts either:
   * - `{ filePath, line, column }` (traditional)
   * - `{ filePath, text }` (resolve text to position)
   * - `{ filePath, symbol }` (resolve symbol to position)
   */
  async function parsePositionInput(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ filePath: string; line: number; column: number }> {
    if (
      typeof input.filePath !== 'string' ||
      input.filePath.trim().length === 0
    ) {
      throw new Error(`${toolName} requires a non-empty filePath string.`);
    }
    const filePath = path.resolve(workspaceRoot, input.filePath);

    // If text or symbol is provided, resolve from that
    if (typeof input.text === 'string' && input.text.length > 0) {
      await syncFileIfNeeded(filePath);
      return {
        filePath,
        ...(await resolveTextPosition(filePath, input.text)),
      };
    }

    if (typeof input.symbol === 'string' && input.symbol.length > 0) {
      await syncFileIfNeeded(filePath);
      return {
        filePath,
        ...(await resolveSymbolPosition(filePath, input.symbol)),
      };
    }

    // Fall back to line/column
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

    return { filePath, line: input.line, column: input.column };
  }

  async function resolveAtPosition(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ResolvedPosition> {
    const { filePath, line, column } = await parsePositionInput(
      toolName,
      input
    );
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
        return '# LSP Diagnostics\n\nClean. No errors or warnings detected.';
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

      return `# LSP Diagnostics\n\n${lines.join('\n')}`;
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

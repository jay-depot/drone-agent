import path from 'node:path';
import type {
  DroneLspDiagnostic,
  DroneLspServerConfig,
  DroneLspServerState,
} from 'drone-core';
import { commandExistsOnPath } from 'drone-core';
import {
  fromFileUri,
  normalizeFileExtensions,
  normalizeSeverity,
} from './normalize/index.js';
import {
  formatServerDetail,
  getKnownServerSpec,
  KNOWN_SERVER_SPECS,
  type KnownServerSpec,
} from './known-servers.js';
import {
  resolveServerCommand as resolveServerCommandImpl,
  type ResolvedSpawn,
} from './server/spawn-resolution.js';
import {
  ensureDocumentLoaded as ensureDocumentLoadedImpl,
  syncFileIfNeeded as syncFileIfNeededImpl,
  syncServerDocuments as syncServerDocumentsImpl,
} from './server/documents.js';
import {
  createRuntimeFromConfig as createRuntimeFromConfigImpl,
  initializeClient as initializeClientImpl,
  type RuntimeFactoryHooks,
} from './server/runtime-factory.js';
import type { ServerRuntime } from './server/types.js';
import {
  ReferenceCache,
  readLineFingerprint as readLineFingerprintImpl,
  readFileSnippet as readFileSnippetImpl,
  type ReferenceLocation,
  type ReferenceResolution,
} from './server/reference-cache.js';
import {
  resolveSymbolPosition as resolveSymbolPositionInModule,
  resolveTextPosition as resolveTextPositionInModule,
  type PositionContext,
  type PositionDocument,
  type PositionRuntime,
} from './server/position.js';
import {
  workspaceHasMarkers,
  estimateTokenCount,
  sortDiagnostics,
  type PublishDiagnosticsParams,
} from './server/helpers.js';
import {
  CrashGuard,
  createInFlightDedup,
  killWithEscalation,
  CRASH_GUARD_FAILURE_LIMIT,
  CRASH_GUARD_WINDOW_MS,
  KILL_GRACE_MS,
} from './server/lifecycle.js';

import type { DocumentState } from './server/types.js';
export type { DocumentState } from './server/types.js';
import type {
  CreateServerManagerOptions as CreateServerManagerOptionsImpl,
  ResolvedPosition,
  ServerManager,
} from './server/manager-types.js';

export type {
  ResolvedPosition,
  ServerManager,
} from './server/manager-types.js';
export type {
  ReferenceLocation,
  ReferenceResolution,
} from './server/reference-cache.js';
type CreateServerManagerOptions = CreateServerManagerOptionsImpl;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createServerManager(
  options: CreateServerManagerOptions
): ServerManager {
  const { workspaceRoot, lspConfig, logger } = options;
  const diagnosticsByFile = new Map<string, DroneLspDiagnostic[]>();
  const serverRuntimes = new Map<string, ServerRuntime>();
  const serverStates = new Map<string, DroneLspServerState>();
  const startDedup = createInFlightDedup<string>();
  const installDedup = createInFlightDedup<string>();
  const crashGuard = new CrashGuard();
  const referenceCache = new ReferenceCache();
  let shuttingDown = false;
  let workspaceDirty = true;

  // ── Internal helpers ──────────────────────────────────────────────

  function updateServerState(
    serverId: string,
    update: Partial<DroneLspServerState>
  ): void {
    const existing = serverStates.get(serverId);
    if (!existing) {
      return;
    }
    serverStates.set(serverId, {
      ...existing,
      ...update,
    });
  }

  function ensureServerState(
    serverId: string,
    seed: DroneLspServerState
  ): DroneLspServerState {
    const existing = serverStates.get(serverId);
    if (existing) {
      return existing;
    }
    serverStates.set(serverId, seed);
    return seed;
  }

  function removeServer(serverId: string): void {
    serverRuntimes.delete(serverId);
    serverStates.delete(serverId);
  }

  /**
   * Handle a transport-level failure on a spawned server: the runtime is
   * removed from the live map (so a later tool call can restart it) and the
   * state record keeps the error + stderr tail for forensics.
   */
  function handleSpawnedTransportIssue(
    runtime: ServerRuntime,
    message: string
  ): void {
    if (shuttingDown) {
      return;
    }
    serverRuntimes.delete(runtime.id);
    updateServerState(runtime.id, {
      status: 'error',
      lastError: `${message}${runtime.childTransport ? `\nstderr tail:\n${runtime.childTransport.lastStderrTail().join('\n')}` : ''}`,
    });
    crashGuard.record(runtime.id);
    logger.warn(`lsp server issue: ${runtime.id} (${message})`);
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

  const runtimeFactoryHooks: RuntimeFactoryHooks = {
    workspaceRoot,
    requestTimeoutMs: lspConfig.requestTimeoutMs,
    ensureServerState,
    updateServerState,
    onPublishDiagnostics: handlePublishDiagnostics,
    getLiveRuntime: serverId => serverRuntimes.get(serverId),
    handleSpawnedTransportIssue,
  };

  function initializeClient(runtime: ServerRuntime): Promise<void> {
    return initializeClientImpl(runtime, runtimeFactoryHooks);
  }

  function createRuntimeFromConfig(
    serverId: string,
    language: string,
    config: DroneLspServerConfig,
    resolved: ResolvedSpawn | null
  ): Promise<ServerRuntime> {
    return createRuntimeFromConfigImpl(
      serverId,
      language,
      config,
      resolved,
      runtimeFactoryHooks
    );
  }

  function resolveServerCommand(
    serverId: string,
    language: string,
    config: DroneLspServerConfig,
    knownSpec: KnownServerSpec | undefined
  ): Promise<ResolvedSpawn | null> {
    return resolveServerCommandImpl(
      serverId,
      language,
      config,
      knownSpec,
      lspConfig.autoInstall,
      logger
    );
  }

  async function detectKnownLanguageSpecs(): Promise<KnownServerSpec[]> {
    const matches: KnownServerSpec[] = [];
    for (const spec of KNOWN_SERVER_SPECS) {
      // Only root-marker specs (typescript, python, rust, go, lua, svelte,
      // php) are detected eagerly. Ambient specs (no rootPatterns) start
      // lazily via startServerForFile when a matching file is touched.
      if (
        spec.rootPatterns.length > 0 &&
        (await workspaceHasMarkers(workspaceRoot, spec.rootPatterns))
      ) {
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
      let resolved: ResolvedSpawn | null;
      let installStatus: DroneLspServerState['installStatus'];

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
        ensureServerState(candidate.serverId, {
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
        });
        continue;
      }

      try {
        const runtime = await createRuntimeFromConfig(
          candidate.serverId,
          candidate.language,
          candidate.config,
          resolved
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
        serverRuntimes.delete(candidate.serverId);
        ensureServerState(candidate.serverId, {
          id: candidate.serverId,
          language: candidate.language,
          transport: candidate.config.transport === 'tcp' ? 'tcp' : 'stdio',
          ownership:
            candidate.config.transport === 'tcp' ? 'external' : 'spawned',
          status: 'error',
          detail: formatServerDetail(candidate.config),
          lastError: message,
          installSource: resolved?.source ?? 'path',
          installStatus: 'failed',
        });
      }
    }
  }

  /**
   * Opt-in background warm-up (lsp.preinstall): install known servers that
   * are not running and not configured, without spawning them. Uses the
   * install-only in-flight dedup (not the spawn-start one) so installs are
   * serialized per spec while demand starts stay independent. Failures warn
   * and continue — the warm-up must never reject session start.
   */
  function knownSpecToConfig(spec: KnownServerSpec): DroneLspServerConfig {
    return {
      transport: 'stdio',
      language: spec.language,
      command: spec.command,
      args: spec.args,
      fileExtensions: spec.fileExtensions,
      rootPatterns: spec.rootPatterns,
    };
  }

  function preinstallKnownServers(): void {
    const skip = new Set<string>([
      ...serverRuntimes.keys(),
      ...Object.keys(lspConfig.servers),
    ]);
    for (const spec of KNOWN_SERVER_SPECS) {
      if (skip.has(spec.id)) {
        continue;
      }
      void installDedup
        .run(spec.id, async () => {
          if (crashGuard.isBlocked(spec.id)) {
            return false;
          }
          if (
            !lspConfig.autoInstall &&
            !(await commandExistsOnPath(spec.command))
          ) {
            return false;
          }
          await resolveServerCommand(
            spec.id,
            spec.language,
            knownSpecToConfig(spec),
            spec
          );
          return true;
        })
        .catch(error => {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn(`lsp preinstall failed: ${spec.id} (${message})`);
        });
    }
  }

  // ── Inner functions (used by public API and by each other) ──────

  function findRuntimeForFile(filePath: string): ServerRuntime | undefined {
    const extension = path.extname(filePath).toLowerCase();
    for (const runtime of serverRuntimes.values()) {
      if (
        (serverStates.get(runtime.id)?.status ?? 'connecting') ===
          'connected' &&
        runtime.fileExtensions.includes(extension)
      ) {
        return runtime;
      }
    }
    return undefined;
  }

  async function syncServerDocuments(runtime: ServerRuntime): Promise<void> {
    const closedPaths = await syncServerDocumentsImpl(
      runtime,
      workspaceRoot,
      () => serverStates.get(runtime.id)?.status === 'connected'
    );
    for (const closedPath of closedPaths) {
      diagnosticsByFile.delete(closedPath);
    }
  }

  function ensureDocumentLoaded(
    runtime: ServerRuntime,
    filePath: string
  ): Promise<DocumentState> {
    return ensureDocumentLoadedImpl(
      runtime,
      filePath
    ) as Promise<DocumentState>;
  }

  async function syncFileIfNeeded(filePath: string): Promise<void> {
    const runtime = findRuntimeForFile(filePath);
    if (!runtime) return;
    await syncFileIfNeededImpl(runtime, filePath);
  }

  const positionContext: PositionContext = {
    requireRuntimeForFile: async filePath =>
      (await requireRuntimeForFile(filePath)) as unknown as PositionRuntime,
    ensureDocumentLoaded: async (runtime, filePath) =>
      (await ensureDocumentLoaded(
        runtime as unknown as ServerRuntime,
        filePath
      )) as unknown as PositionDocument,
    readLineFingerprint,
  };

  /**
   * Parse position input from a tool call. Accepts either:
   * - `{ filePath, line, column }` (traditional)
   * - `{ filePath, text }` (resolve text to position)
   * - `{ filePath, symbol }` (resolve symbol to position)
   */
  async function parsePositionInput(
    toolName: string,
    input: Record<string, unknown>,
    surroundingText?: string
  ): Promise<{ filePath: string; line: number; column: number }> {
    if (
      typeof input.filePath !== 'string' ||
      input.filePath.trim().length === 0
    ) {
      throw new Error(`${toolName} requires a non-empty filePath string.`);
    }
    const filePath = path.resolve(workspaceRoot, input.filePath);
    const effectiveSurroundingText =
      surroundingText ??
      (typeof input.surroundingText === 'string'
        ? input.surroundingText
        : undefined);

    // If text or symbol is provided, resolve from that
    if (typeof input.text === 'string' && input.text.length > 0) {
      await syncFileIfNeeded(filePath);
      return {
        filePath,
        ...(await resolveTextPositionInModule(
          positionContext,
          filePath,
          input.text,
          effectiveSurroundingText
        )),
      };
    }
    if (typeof input.symbol === 'string' && input.symbol.length > 0) {
      await syncFileIfNeeded(filePath);
      return {
        filePath,
        ...(await resolveSymbolPositionInModule(
          positionContext,
          filePath,
          input.symbol,
          effectiveSurroundingText
        )),
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
    input: Record<string, unknown>,
    surroundingText?: string
  ): Promise<ResolvedPosition> {
    const { filePath, line, column } = await parsePositionInput(
      toolName,
      input,
      surroundingText
    );
    const runtime = await requireRuntimeForFile(filePath);
    const document = await ensureDocumentLoaded(runtime, filePath);
    return { runtime, document, line, column };
  }

  function readLineFingerprint(
    filePath: string,
    line: number
  ): Promise<string | undefined> {
    return readLineFingerprintImpl(filePath, line);
  }

  function storeReferences(locations: ReferenceLocation[]): Promise<string[]> {
    return referenceCache.store(locations);
  }

  function resolveReference(
    referenceId: string
  ): Promise<ReferenceResolution | undefined> {
    return referenceCache.resolve(referenceId, readLineFingerprintImpl);
  }

  function readFileSnippet(
    filePath: string,
    line: number,
    contextLines: number = 5
  ): Promise<string> {
    return readFileSnippetImpl(filePath, line, contextLines);
  }

  // ── Public API ────────────────────────────────────────────────────

  async function startCandidate(
    serverId: string,
    language: string,
    config: DroneLspServerConfig,
    knownSpec: KnownServerSpec | undefined
  ): Promise<boolean> {
    return startDedup.run(serverId, async () => {
      // Re-check under the dedup: another caller may have finished a start
      // while we waited, or a runtime may already be live (even connecting).
      const live = serverRuntimes.get(serverId);
      if (live) {
        return false;
      }
      if (crashGuard.isBlocked(serverId)) {
        logger.warn(
          `lsp server ${serverId} refused to start: crash guard tripped (${CRASH_GUARD_FAILURE_LIMIT} failures in ${CRASH_GUARD_WINDOW_MS}ms)`
        );
        return false;
      }
      if (shuttingDown) {
        return false;
      }

      let resolved: ResolvedSpawn | null;
      let installStatus: DroneLspServerState['installStatus'];

      try {
        resolved = await resolveServerCommand(
          serverId,
          language,
          config,
          knownSpec
        );
        installStatus = resolved?.installStatus ?? 'unused';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`lsp server unavailable: ${serverId} (${message})`);
        ensureServerState(serverId, {
          id: serverId,
          language,
          transport: config.transport === 'tcp' ? 'tcp' : 'stdio',
          ownership: config.transport === 'tcp' ? 'external' : 'spawned',
          status: 'error',
          detail: formatServerDetail(config),
          lastError: message,
          installSource: 'path',
          installStatus: 'failed',
        });
        throw new Error(
          `Failed to prepare LSP server ${serverId}: ${message}`,
          { cause: error }
        );
      }

      try {
        const runtime = await createRuntimeFromConfig(
          serverId,
          language,
          config,
          resolved
        );
        if (shuttingDown) {
          // Teardown began while this start was in flight. Kill the child
          // immediately and register nothing (orphan prevention).
          runtime.client.disconnect('server shutting down');
          if (runtime.childProcess) {
            await killWithEscalation(runtime.childProcess, KILL_GRACE_MS);
          }
          removeServer(serverId);
          return false;
        }
        if (resolved) {
          updateServerState(runtime.id, {
            installSource: resolved.source,
            installStatus,
          });
        }
        serverRuntimes.set(runtime.id, runtime);
        await initializeClient(runtime);
        workspaceDirty = true;
        logger.info(
          `lsp server ready: ${runtime.id} (${runtime.ownership}, ${runtime.detail}, install=${installStatus})`
        );
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`lsp server unavailable: ${serverId} (${message})`);
        serverRuntimes.delete(serverId);
        ensureServerState(serverId, {
          id: serverId,
          language,
          transport: config.transport === 'tcp' ? 'tcp' : 'stdio',
          ownership: config.transport === 'tcp' ? 'external' : 'spawned',
          status: 'error',
          detail: formatServerDetail(config),
          lastError: message,
          installSource: resolved?.source ?? 'path',
          installStatus: 'failed',
        });
        crashGuard.record(serverId);
        throw new Error(`Failed to start LSP server ${serverId}: ${message}`, {
          cause: error,
        });
      }
    });
  }

  function findConfiguredServerForExtension(
    extension: string
  ): { serverId: string; config: DroneLspServerConfig } | undefined {
    for (const [serverId, config] of Object.entries(lspConfig.servers)) {
      const language = config.language ?? serverId;
      const extensions = normalizeFileExtensions(
        config.fileExtensions ??
          getKnownServerSpec(language)?.fileExtensions ??
          []
      );
      if (extensions.includes(extension)) {
        return { serverId, config };
      }
    }
    return undefined;
  }

  async function startServerForFile(filePath: string): Promise<boolean> {
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) {
      return false;
    }

    // A configured server whose declared extensions match the file wins —
    // this also covers demand restarts of crashed configured servers.
    const configured = findConfiguredServerForExtension(ext);
    if (configured) {
      const language = configured.config.language ?? configured.serverId;
      return startCandidate(
        configured.serverId,
        language,
        configured.config,
        getKnownServerSpec(language)
      );
    }

    // Otherwise, a known spec that handles this extension (ambient lazy
    // start for languages with no explicit config).
    const spec = KNOWN_SERVER_SPECS.find(s =>
      s.fileExtensions.some(fe => fe.toLowerCase() === ext)
    );
    if (!spec) {
      return false;
    }
    return startCandidate(
      spec.id,
      spec.language,
      knownSpecToConfig(spec),
      spec
    );
  }

  /**
   * Chokepoint for tools that need a live runtime for a specific file.
   * Finds an existing connected runtime; on a miss, demand-starts the spec
   * for the file's extension and re-checks; throws the tool-facing error
   * when no server can serve the file.
   */
  async function requireRuntimeForFile(
    filePath: string
  ): Promise<ServerRuntime> {
    const existing = findRuntimeForFile(filePath);
    if (existing) {
      return existing;
    }
    const started = await startServerForFile(filePath).catch(error => {
      logger.warn(
        `lsp demand start failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    });
    if (started) {
      const runtime = findRuntimeForFile(filePath);
      if (runtime) {
        return runtime;
      }
    }
    throw new Error(`No connected LSP server is available for ${filePath}.`);
  }

  return {
    initialize: async () => {
      await initializeServers();
      if (lspConfig.preinstall) {
        preinstallKnownServers();
      }
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

    getServerStates: () => Array.from(serverStates.values()),

    getAvailableServers: () => {
      const running = new Set(serverRuntimes.keys());
      return KNOWN_SERVER_SPECS.filter(spec => !running.has(spec.id)).map(
        spec => ({
          id: spec.id,
          language: spec.language,
          fileExtensions: spec.fileExtensions,
          status: 'available' as const,
        })
      );
    },

    startServerForFile,

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
    requireRuntimeForFile,
    ensureDocumentLoaded,

    resolveTargetFilePath: (inputPath: string) => {
      return path.resolve(workspaceRoot, inputPath);
    },

    parsePositionInput,
    resolveAtPosition,

    readFileSnippet,
    readLineFingerprint,
    storeReferences,
    resolveReference,

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
        range: {
          start: {
            line: location.range.start.line + 1,
            character: location.range.start.character + 1,
          },
          end: {
            line: location.range.end.line + 1,
            character: location.range.end.character + 1,
          },
        },
      }));
    },

    shutdown: async () => {
      shuttingDown = true;
      const runtimes = Array.from(serverRuntimes.values());
      serverRuntimes.clear();

      for (const runtime of runtimes) {
        if (
          runtime.ownership === 'spawned' &&
          serverStates.get(runtime.id)?.status === 'connected'
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

        // Disconnect before closing stdin: markClosed runs first so any
        // in-flight write completion cannot surface as an EPIPE transport
        // issue (EPIPE-safety ordering).
        runtime.client.disconnect('plugin shutdown');
        if (runtime.ownership === 'spawned' && runtime.childProcess) {
          await killWithEscalation(runtime.childProcess, KILL_GRACE_MS);
        }
        updateServerState(runtime.id, {
          status: 'disconnected',
        });
      }
    },
  };
}

import type {
  DroneLspDiagnostic,
  DroneLspHoverResult,
  DroneLspServerConfig,
  DroneLspServerState,
  DronePlugin,
} from 'drone-core';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  commandExistsOnPath,
  computeCacheKey,
  ensureServerInstalled,
  resolveCacheDir,
  type InstallerResolution,
  type InstallerSpec,
} from './lsp-installer.js';

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

/**
 * Optional, declarative metadata for auto-installing a server when it isn't on
 * PATH. When present, the plugin will lazily download the npm tarball into a
 * per-user cache and invoke it via the running Node interpreter. Integrity is
 * the npm `dist.integrity` value (sha512-base64) — the same field npm
 * verifies before extracting — so the threat model matches a regular
 * `npm install`.
 *
 * `nodeEntry` is the path inside the unpacked tarball that should be passed
 * to `node` (e.g. `lib/cli.mjs`). It does not need to be executable; we
 * resolve the absolute path and invoke Node directly, which sidesteps
 * shebang/Windows-PATH issues.
 */
export type KnownServerInstallSpec = {
  npmPackage: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  nodeEntry: string;
};

export type KnownServerSpec = {
  id: string;
  language: string;
  command: string;
  args: string[];
  fileExtensions: string[];
  rootPatterns: string[];
  install?: KnownServerInstallSpec;
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
    install: {
      npmPackage: 'typescript-language-server',
      version: '5.3.0',
      tarballUrl:
        'https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-5.3.0.tgz',
      // Pinned sha512-base64 of the actual tarball bytes, computed locally
      // (sha512sum / openssl dgst -sha512). Note: this intentionally
      // differs by one base64 character from the `dist.integrity` field
      // published in the npm registry metadata for v5.3.0 — that field
      // appears to be stale, since the published `shasum` is also off
      // by a bit. We pin to the digest the actual bytes produce so the
      // safety property holds; if a future republish changes the
      // tarball, bump this value alongside `version`.
      integrity:
        'sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==',
      // typescript-language-server is published as ESM with a `bin`
      // declaration pointing at `lib/cli.mjs`. After extracting the
      // tarball we invoke Node directly on that file.
      nodeEntry: 'lib/cli.mjs',
    },
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

function severityToLsp(
  severity: DroneLspDiagnostic['severity']
): number {
  switch (severity) {
    case 'error':
      return 1;
    case 'warning':
      return 2;
    case 'information':
      return 3;
    case 'hint':
      return 4;
    default:
      return 1;
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

// ---------------------------------------------------------------------------
// LSP response shapes for the additional tools
// ---------------------------------------------------------------------------

type LspDocumentSymbolResponse = {
  name?: string;
  kind?: number | string;
  detail?: string;
  tags?: Array<number | string>;
  deprecated?: boolean;
  range?: LspRangeResponse;
  selectionRange?: LspRangeResponse;
  children?: LspDocumentSymbolResponse[];
  containerName?: string;
  location?: {
    uri?: string;
    range?: LspRangeResponse;
  };
};

type LspWorkspaceSymbolResponse = {
  name?: string;
  kind?: number | string;
  tags?: Array<number | string>;
  containerName?: string;
  location?: {
    uri?: string;
    range?: LspRangeResponse;
  };
};

type LspParameterInformation = {
  label?: string | [number, number];
  documentation?: unknown;
};

type LspSignatureInformation = {
  label?: string;
  documentation?: unknown;
  parameters?: LspParameterInformation[];
  activeParameter?: number;
};

type LspSignatureHelpResponse = {
  signatures?: LspSignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
};

type LspCompletionItemResponse = {
  label?: string;
  kind?: number | string;
  tags?: Array<number | string>;
  detail?: string;
  documentation?: unknown;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: {
    range?: LspRangeResponse;
    newText?: string;
  };
  additionalTextEdits?: Array<{
    range?: LspRangeResponse;
    newText?: string;
  }>;
  commitCharacters?: string[];
  command?: { title?: string; command?: string; arguments?: unknown[] };
};

type LspCompletionListResponse = {
  isIncomplete?: boolean;
  items?: LspCompletionItemResponse[];
};

type LspCommandResponse = {
  title?: string;
  command?: string;
  arguments?: unknown[];
};

type LspCodeActionResponse = {
  title?: string;
  kind?: string;
  diagnostics?: Array<{ code?: string | number }>;
  isPreferred?: boolean;
  disabled?: { reason?: string };
  edit?: LspWorkspaceEdit;
  command?: LspCommandResponse;
};

type LspWorkspaceEdit = {
  changes?: Array<{
    uri?: string;
    edits?: Array<{
      range?: LspRangeResponse;
      newText?: string;
    }>;
  }>;
  documentChanges?: Array<LspDocumentChange>;
};

/**
 * LSP documentChanges is a tagged union. Each entry either carries a
 * `kind` (create/rename/delete) or is a TextDocumentEdit (no `kind`,
 * has `textDocument` + `edits`). We model both variants explicitly so
 * the runtime narrowing in `normalizeWorkspaceEdit` is type-safe.
 */
type LspDocumentChange =
  | {
      kind: 'create';
      uri?: string;
    }
  | {
      kind: 'delete';
      uri?: string;
    }
  | {
      kind: 'rename';
      oldUri?: string;
      newUri?: string;
    }
  | {
      textDocument?: { uri?: string; version?: number };
      edits?: Array<{
        range?: LspRangeResponse;
        newText?: string;
      }>;
    };

type LspCallHierarchyItem = {
  name?: string;
  kind?: number | string;
  detail?: string;
  uri?: string;
  range?: LspRangeResponse;
  selectionRange?: LspRangeResponse;
};

type LspCallHierarchyCall = {
  from?: LspCallHierarchyItem[];
  to?: LspCallHierarchyItem[];
};

// LSP SymbolKind numeric values (3.17 spec). We expose them as named
// constants so the agent sees "Function" / "Class" instead of "12".
const LSP_SYMBOL_KIND: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter',
};

const LSP_COMPLETION_ITEM_KIND: Record<number, string> = {
  1: 'Text',
  2: 'Method',
  3: 'Function',
  4: 'Constructor',
  5: 'Field',
  6: 'Variable',
  7: 'Class',
  8: 'Interface',
  9: 'Module',
  10: 'Property',
  11: 'Unit',
  12: 'Value',
  13: 'Enum',
  14: 'Keyword',
  15: 'Snippet',
  16: 'Color',
  17: 'File',
  18: 'Reference',
  19: 'Folder',
  20: 'EnumMember',
  21: 'Constant',
  22: 'Struct',
  23: 'Event',
  24: 'Operator',
  25: 'TypeParameter',
};

function formatSymbolKind(kind: number | string | undefined): string {
  if (kind === undefined) {
    return 'Unknown';
  }
  if (typeof kind === 'string') {
    return kind;
  }
  return LSP_SYMBOL_KIND[kind] ?? `kind:${kind}`;
}

function formatCompletionKind(
  kind: number | string | undefined
): string {
  if (kind === undefined) {
    return 'Unknown';
  }
  if (typeof kind === 'string') {
    return kind;
  }
  return LSP_COMPLETION_ITEM_KIND[kind] ?? `kind:${kind}`;
}

function normalizeMarkupContent(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value)) {
    if (typeof value.value === 'string') {
      return value.value;
    }
  }
  return '';
}

type NormalizedSymbol = {
  name: string;
  kind: string;
  containerName?: string;
  filePath?: string;
  line?: number;
  column?: number;
  detail?: string;
  deprecated?: boolean;
  children?: NormalizedSymbol[];
};

function flattenDocumentSymbols(
  symbols: LspDocumentSymbolResponse[] | null | undefined
): NormalizedSymbol[] {
  if (!symbols) {
    return [];
  }
  const out: NormalizedSymbol[] = [];
  for (const symbol of symbols) {
    if (!symbol || typeof symbol.name !== 'string') {
      continue;
    }
    const range = symbol.range ?? symbol.selectionRange;
    const normalized: NormalizedSymbol = {
      name: symbol.name,
      kind: formatSymbolKind(symbol.kind),
      containerName:
        typeof symbol.containerName === 'string'
          ? symbol.containerName
          : undefined,
      detail:
        typeof symbol.detail === 'string' ? symbol.detail : undefined,
      deprecated:
        symbol.deprecated === true ||
        (Array.isArray(symbol.tags) && symbol.tags.includes(1)),
      children:
        symbol.children && symbol.children.length > 0
          ? flattenDocumentSymbols(symbol.children)
          : undefined,
    };
    if (range) {
      normalized.line = (range.start?.line ?? 0) + 1;
      normalized.column = (range.start?.character ?? 0) + 1;
    }
    out.push(normalized);
  }
  return out;
}

function normalizeWorkspaceSymbols(
  symbols: LspWorkspaceSymbolResponse[] | null | undefined
): NormalizedSymbol[] {
  if (!symbols) {
    return [];
  }
  const out: NormalizedSymbol[] = [];
  for (const symbol of symbols) {
    if (!symbol || typeof symbol.name !== 'string') {
      continue;
    }
    const uri = symbol.location?.uri;
    const filePath =
      typeof uri === 'string' ? fromFileUri(uri) : undefined;
    const range = symbol.location?.range;
    const normalized: NormalizedSymbol = {
      name: symbol.name,
      kind: formatSymbolKind(symbol.kind),
      containerName:
        typeof symbol.containerName === 'string'
          ? symbol.containerName
          : undefined,
      filePath: filePath ?? undefined,
      line: range ? (range.start?.line ?? 0) + 1 : undefined,
      column: range ? (range.start?.character ?? 0) + 1 : undefined,
      deprecated:
        Array.isArray(symbol.tags) && symbol.tags.includes(1),
    };
    out.push(normalized);
  }
  return out;
}

type NormalizedSignatureHelp = {
  activeSignature: number;
  activeParameter: number;
  signatures: Array<{
    label: string;
    documentation?: string;
    parameters: Array<{
      label: string;
      documentation?: string;
    }>;
    activeParameter?: number;
  }>;
};

function normalizeSignatureHelp(
  response: LspSignatureHelpResponse | null | undefined
): NormalizedSignatureHelp {
  const signatures = response?.signatures ?? [];
  const activeSignature = response?.activeSignature ?? 0;
  const fallbackActiveParameter = response?.activeParameter ?? 0;
  return {
    activeSignature,
    activeParameter: fallbackActiveParameter,
    signatures: signatures
      .filter(
        (signature): signature is LspSignatureInformation =>
          typeof signature === 'object' && signature !== null
      )
      .map(signature => {
        const activeParameter =
          signature.activeParameter ?? fallbackActiveParameter;
        return {
          label: signature.label ?? '',
          documentation: normalizeMarkupContent(signature.documentation),
          parameters: (signature.parameters ?? []).map(parameter => {
            let labelText = '';
            if (typeof parameter.label === 'string') {
              labelText = parameter.label;
            } else if (
              Array.isArray(parameter.label) &&
              parameter.label.length === 2 &&
              typeof signature.label === 'string'
            ) {
              const [start, end] = parameter.label;
              labelText = signature.label.slice(start, end);
            }
            return {
              label: labelText,
              documentation: normalizeMarkupContent(
                parameter.documentation
              ),
            };
          }),
          activeParameter,
        };
      }),
  };
}

type NormalizedCompletionItem = {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
  insertText?: string;
};

function normalizeCompletionItems(
  response:
    | LspCompletionItemResponse[]
    | LspCompletionListResponse
    | null
    | undefined
): { isIncomplete: boolean; items: NormalizedCompletionItem[] } {
  if (!response) {
    return { isIncomplete: false, items: [] };
  }
  let isIncomplete = false;
  let rawItems: LspCompletionItemResponse[];
  if (Array.isArray(response)) {
    rawItems = response;
  } else {
    isIncomplete = response.isIncomplete === true;
    rawItems = response.items ?? [];
  }
  const items: NormalizedCompletionItem[] = [];
  for (const item of rawItems) {
    if (!item || typeof item.label !== 'string') {
      continue;
    }
    items.push({
      label: item.label,
      kind: formatCompletionKind(item.kind),
      detail: typeof item.detail === 'string' ? item.detail : undefined,
      documentation: normalizeMarkupContent(item.documentation),
      sortText:
        typeof item.sortText === 'string' ? item.sortText : undefined,
      filterText:
        typeof item.filterText === 'string' ? item.filterText : undefined,
      insertText:
        typeof item.insertText === 'string' ? item.insertText : undefined,
    });
  }
  return { isIncomplete, items };
}

type NormalizedTextEdit = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
};

function normalizeTextEdits(
  edits:
    | Array<{ range?: LspRangeResponse; newText?: string }>
    | null
    | undefined
): NormalizedTextEdit[] {
  if (!edits) {
    return [];
  }
  return edits
    .filter(edit => edit && typeof edit.newText === 'string')
    .map(edit => ({
      range: normalizeLspRange(edit.range),
      newText: edit.newText ?? '',
    }));
}

type NormalizedWorkspaceEdit = {
  changes: Array<{ filePath: string; edits: NormalizedTextEdit[] }>;
  documentChanges: Array<
    | {
        kind: 'textEdit';
        filePath: string;
        edits: NormalizedTextEdit[];
        version?: number;
      }
    | { kind: 'create'; filePath: string }
    | { kind: 'rename'; oldPath: string; newPath: string }
    | { kind: 'delete'; filePath: string }
  >;
};

function isCreateOp(
  change: LspDocumentChange
): change is { kind: 'create'; uri?: string } {
  return (change as { kind?: string }).kind === 'create';
}

function isDeleteOp(
  change: LspDocumentChange
): change is { kind: 'delete'; uri?: string } {
  return (change as { kind?: string }).kind === 'delete';
}

function isRenameOp(
  change: LspDocumentChange
): change is { kind: 'rename'; oldUri?: string; newUri?: string } {
  return (change as { kind?: string }).kind === 'rename';
}

function normalizeWorkspaceEdit(
  edit: LspWorkspaceEdit | null | undefined
): NormalizedWorkspaceEdit {
  const changes: NormalizedWorkspaceEdit['changes'] = [];
  for (const change of edit?.changes ?? []) {
    if (!change || typeof change.uri !== 'string') {
      continue;
    }
    const filePath = fromFileUri(change.uri);
    if (!filePath) {
      continue;
    }
    changes.push({
      filePath,
      edits: normalizeTextEdits(change.edits),
    });
  }

  const documentChanges: NormalizedWorkspaceEdit['documentChanges'] = [];
  for (const change of edit?.documentChanges ?? []) {
    if (!change) {
      continue;
    }
    if (isCreateOp(change)) {
      const filePath =
        typeof change.uri === 'string' ? fromFileUri(change.uri) : null;
      if (filePath) {
        documentChanges.push({ kind: 'create', filePath });
      }
      continue;
    }
    if (isDeleteOp(change)) {
      const filePath =
        typeof change.uri === 'string' ? fromFileUri(change.uri) : null;
      if (filePath) {
        documentChanges.push({ kind: 'delete', filePath });
      }
      continue;
    }
    if (isRenameOp(change)) {
      const oldPath =
        typeof change.oldUri === 'string'
          ? fromFileUri(change.oldUri)
          : null;
      const newPath =
        typeof change.newUri === 'string'
          ? fromFileUri(change.newUri)
          : null;
      if (oldPath && newPath) {
        documentChanges.push({
          kind: 'rename',
          oldPath,
          newPath,
        });
      }
      continue;
    }
    // Anything without a recognized `kind` is treated as a
    // TextDocumentEdit. We accept the `as` cast here because LSP
    // servers in the wild occasionally omit `kind` discriminators.
    const textDocEdit = change as {
      textDocument?: { uri?: string; version?: number };
      edits?: Array<{
        range?: LspRangeResponse;
        newText?: string;
      }>;
    };
    const uri = textDocEdit.textDocument?.uri;
    const filePath = typeof uri === 'string' ? fromFileUri(uri) : null;
    if (!filePath) {
      continue;
    }
    documentChanges.push({
      kind: 'textEdit',
      filePath,
      edits: normalizeTextEdits(textDocEdit.edits),
      version:
        typeof textDocEdit.textDocument?.version === 'number'
          ? textDocEdit.textDocument.version
          : undefined,
    });
  }

  return { changes, documentChanges };
}

type NormalizedCodeAction = {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabledReason?: string;
  edit?: NormalizedWorkspaceEdit;
  command?: { title?: string; command?: string };
  // True if the action's effects aren't fully captured in the edit and
  // would need server-side execution. Agents should be cautious about
  // these.
  requiresServerCommand: boolean;
};

function normalizeCodeActions(
  actions: LspCodeActionResponse[] | null | undefined
): NormalizedCodeAction[] {
  if (!actions) {
    return [];
  }
  return actions
    .filter(
      (action): action is LspCodeActionResponse =>
        typeof action === 'object' && action !== null
    )
    .filter(action => typeof action.title === 'string')
    .map(action => ({
      title: action.title as string,
      kind: typeof action.kind === 'string' ? action.kind : undefined,
      isPreferred: action.isPreferred === true,
      disabledReason:
        typeof action.disabled?.reason === 'string'
          ? action.disabled.reason
          : undefined,
      edit: action.edit ? normalizeWorkspaceEdit(action.edit) : undefined,
      command:
        action.command && typeof action.command.command === 'string'
          ? {
              title:
                typeof action.command.title === 'string'
                  ? action.command.title
                  : undefined,
              command: action.command.command,
            }
          : undefined,
      requiresServerCommand: Boolean(action.command) && !action.edit,
    }));
}

type NormalizedCallHierarchyItem = {
  name: string;
  kind: string;
  detail?: string;
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

function normalizeCallHierarchyItem(
  item: LspCallHierarchyItem | null | undefined
): NormalizedCallHierarchyItem | null {
  if (!item || typeof item.name !== 'string') {
    return null;
  }
  const filePath =
    typeof item.uri === 'string' ? fromFileUri(item.uri) : null;
  if (!filePath) {
    return null;
  }
  const range = item.range ?? item.selectionRange;
  return {
    name: item.name,
    kind: formatSymbolKind(item.kind),
    detail: typeof item.detail === 'string' ? item.detail : undefined,
    filePath,
    line: (range?.start?.line ?? 0) + 1,
    column: (range?.start?.character ?? 0) + 1,
    endLine: (range?.end?.line ?? range?.start?.line ?? 0) + 1,
    endColumn:
      (range?.end?.character ?? range?.start?.character ?? 0) + 1,
  };
}

function normalizeCallHierarchyCalls(
  calls: LspCallHierarchyCall[] | null | undefined
): {
  from: NormalizedCallHierarchyItem[];
  to: NormalizedCallHierarchyItem[];
} {
  const from: NormalizedCallHierarchyItem[] = [];
  const to: NormalizedCallHierarchyItem[] = [];
  for (const call of calls ?? []) {
    for (const item of call.from ?? []) {
      const normalized = normalizeCallHierarchyItem(item);
      if (normalized) {
        from.push(normalized);
      }
    }
    for (const item of call.to ?? []) {
      const normalized = normalizeCallHierarchyItem(item);
      if (normalized) {
        to.push(normalized);
      }
    }
  }
  return { from, to };
}

/**
 * Truncate a WorkspaceEdit so the serialized JSON fits within a token
 * budget. Past the budget, we drop the `edits[]` payload but keep the
 * file list — so the agent still sees which files would change and
 * can decide whether to fetch each one via file.read for the diff. The
 * dropped-files set is reported as `droppedFiles` so the agent knows
 * exactly what it's missing.
 */
function truncateWorkspaceEdit(
  edit: NormalizedWorkspaceEdit,
  tokenBudget: number
): NormalizedWorkspaceEdit & {
  truncated: boolean;
  totalTokensBefore: number;
  droppedFiles: string[];
  retainedFiles: string[];
} {
  const before = JSON.stringify(edit);
  const totalTokensBefore = estimateTokenCount(before);

  // Collect every file referenced by `changes[]` or by textEdit
  // documentChanges. The order we keep here is the order the agent
  // will see in the response, so list the changed files first (which
  // is also the order the LSP server returned them).
  const orderedFiles: string[] = [];
  const seenFiles = new Set<string>();
  const collectFile = (filePath: string): void => {
    if (!seenFiles.has(filePath)) {
      seenFiles.add(filePath);
      orderedFiles.push(filePath);
    }
  };
  for (const change of edit.changes) {
    collectFile(change.filePath);
  }
  for (const change of edit.documentChanges) {
    if (change.kind === 'textEdit') {
      collectFile(change.filePath);
    }
  }

  if (totalTokensBefore <= tokenBudget) {
    return {
      ...edit,
      truncated: false,
      totalTokensBefore,
      droppedFiles: [],
      retainedFiles: orderedFiles,
    };
  }

  // Greedily retain files until adding the next one would push us over
  // budget. The retained edits are kept verbatim; dropped files have
  // their `edits[]` array emptied (so the file is still listed but
  // contains no payload). Resource ops (create/rename/delete) are
  // always retained since they cost almost nothing.
  const retainedFiles: string[] = [];
  const droppedFiles: string[] = [];
  let consumedTokens = 0;
  const baseTokens = (() => {
    // Cost of the response shell with all file edits emptied.
    const empty: NormalizedWorkspaceEdit = {
      changes: edit.changes.map(change => ({
        filePath: change.filePath,
        edits: [],
      })),
      documentChanges: edit.documentChanges.map(change => {
        if (change.kind !== 'textEdit') {
          return change;
        }
        return { ...change, edits: [] };
      }),
    };
    return estimateTokenCount(JSON.stringify(empty));
  })();

  // Build a per-file cost estimate. Heuristic: file's edits contribute
  // roughly proportional to their combined newText length. We measure
  // by serializing each file's edits in isolation.
  const perFileCost = new Map<string, number>();
  for (const filePath of orderedFiles) {
    const only = {
      changes: edit.changes.filter(c => c.filePath === filePath),
      documentChanges: edit.documentChanges.filter(
        c => c.kind === 'textEdit' && c.filePath === filePath
      ),
    };
    const cost = Math.max(
      1,
      estimateTokenCount(JSON.stringify(only)) -
        // Subtract the per-file skeleton cost we already paid in
        // baseTokens. The 8-char fudge accounts for the JSON
        // separators around the file path.
        Math.ceil(filePath.length / 4 + 8)
    );
    perFileCost.set(filePath, cost);
  }

  consumedTokens = baseTokens;
  for (const filePath of orderedFiles) {
    const cost = perFileCost.get(filePath) ?? 1;
    if (consumedTokens + cost <= tokenBudget) {
      retainedFiles.push(filePath);
      consumedTokens += cost;
    } else {
      droppedFiles.push(filePath);
    }
  }

  const retainedSet = new Set(retainedFiles);
  const changes = edit.changes.map(change => ({
    filePath: change.filePath,
    edits: retainedSet.has(change.filePath) ? change.edits : [],
  }));
  const documentChanges = edit.documentChanges.map(change => {
    if (change.kind !== 'textEdit') {
      return change;
    }
    return retainedSet.has(change.filePath)
      ? change
      : { ...change, edits: [] };
  });

  return {
    changes,
    documentChanges,
    truncated: droppedFiles.length > 0,
    totalTokensBefore,
    droppedFiles,
    retainedFiles,
  };
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

    type ResolvedSpawn = {
  command: string;
  args: string[];
  source: InstallerResolution['source'];
  installStatus: DroneLspServerState['installStatus'];
};

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
    logger: registration.logger,
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
            resolved
              ? { command: resolved.command, args: resolved.args }
              : null
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
          registration.logger.info(
            `lsp server ready: ${runtime.id} (${runtime.ownership}, ${runtime.detail}, install=${installStatus})`
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

    // ---------------------------------------------------------------
    // Document / workspace navigation
    // ---------------------------------------------------------------

    type ResolvedPosition = {
      runtime: ServerRuntime;
      document: DocumentState;
      line: number;
      column: number;
    };

    async function resolveAtPosition(
      toolName: string,
      input: Record<string, unknown>
    ): Promise<ResolvedPosition> {
      await refreshWorkspaceIfNeeded();
      const { filePath, line, column } = parsePositionInput(
        toolName,
        input
      );
      const runtime = findRuntimeForFile(filePath);
      if (!runtime) {
        throw new Error(
          `No connected LSP server is available for ${filePath}.`
        );
      }
      const document = await ensureDocumentLoaded(runtime, filePath);
      return { runtime, document, line, column };
    }

    function locationToAgentShape(
      locations: Array<{
        filePath: string;
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      }>
    ): Array<{
      filePath: string;
      line: number;
      column: number;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }> {
      return locations.map(location => ({
        filePath: location.filePath,
        line: location.range.start.line + 1,
        column: location.range.start.character + 1,
        range: location.range,
      }));
    }

    registration.registerTool({
      name: 'document_symbols',
      description:
        'Return the symbols defined in a single file (functions, classes, variables, etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Workspace-relative or absolute file path.',
          },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
      execute: async input => {
        if (
          typeof input.filePath !== 'string' ||
          input.filePath.trim().length === 0
        ) {
          throw new Error('lsp.document_symbols requires a filePath string.');
        }
        await refreshWorkspaceIfNeeded();
        const filePath = resolveTargetFilePath(input.filePath);
        const runtime = findRuntimeForFile(filePath);
        if (!runtime) {
          throw new Error(
            `No connected LSP server is available for ${filePath}.`
          );
        }
        const document = await ensureDocumentLoaded(runtime, filePath);
        const response =
          await runtime.client.request<LspDocumentSymbolResponse[]>(
            'textDocument/documentSymbol',
            { textDocument: { uri: document.uri } }
          );
        const symbols = flattenDocumentSymbols(response);
        return JSON.stringify(
          {
            query: { filePath },
            symbols,
            serverStates: Array.from(serverRuntimes.values()).map(
              r => r.state
            ),
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'workspace_symbol',
      description:
        'Search for symbols across the workspace by name. Supports fuzzy matching where the language server supports it.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Symbol name (or substring) to search for. Empty string returns all symbols.',
          },
          limit: {
            type: 'integer',
            description:
              'Optional maximum number of results. Defaults to 200.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.query !== 'string') {
          throw new Error(
            'lsp.workspace_symbol requires a query string.'
          );
        }
        await refreshWorkspaceIfNeeded();
        const limit =
          typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0
            ? Math.min(input.limit, 1000)
            : 200;
        const allResults: Array<{
          serverId: string;
          symbols: NormalizedSymbol[];
        }> = [];
        for (const runtime of serverRuntimes.values()) {
          if (runtime.state.status !== 'connected') {
            continue;
          }
          try {
            const response =
              await runtime.client.request<LspWorkspaceSymbolResponse[]>(
                'workspace/symbol',
                { query: input.query }
              );
            const symbols = normalizeWorkspaceSymbols(response);
            if (symbols.length > 0) {
              allResults.push({
                serverId: runtime.id,
                symbols,
              });
            }
          } catch (error) {
            registration.logger.warn(
              `workspace/symbol failed on ${runtime.id}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
        const flat = allResults.flatMap(group =>
          group.symbols.map(symbol => ({
            ...symbol,
            serverId: group.serverId,
          }))
        );
        flat.sort((left, right) => left.name.localeCompare(right.name));
        const truncated = flat.length > limit;
        const symbols = truncated ? flat.slice(0, limit) : flat;
        return JSON.stringify(
          {
            query: input.query,
            symbols,
            truncated,
            totalMatches: flat.length,
            serverStates: Array.from(serverRuntimes.values()).map(
              r => r.state
            ),
          },
          null,
          2
        );
      },
    });

    // ---------------------------------------------------------------
    // In-editor assistance
    // ---------------------------------------------------------------

    registration.registerTool({
      name: 'signature_help',
      description:
        'Return LSP signature help for the function call at a given position.',
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
        const { runtime, document, line, column } = await resolveAtPosition(
          'lsp.signature_help',
          input
        );
        const response =
          await runtime.client.request<LspSignatureHelpResponse>(
            'textDocument/signatureHelp',
            {
              textDocument: { uri: document.uri },
              position: { line: line - 1, character: column - 1 },
            }
          );
        const signatures = normalizeSignatureHelp(response);
        return JSON.stringify(
          {
            query: { filePath: document.uri, line, column },
            ...signatures,
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'completion',
      description:
        'Return LSP completion suggestions at a given position. Includes kind, detail, and documentation.',
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
          limit: {
            type: 'integer',
            description:
              'Optional maximum number of items to return. Defaults to 100.',
          },
        },
        required: ['filePath', 'line', 'column'],
        additionalProperties: false,
      },
      execute: async input => {
        const { runtime, document, line, column } = await resolveAtPosition(
          'lsp.completion',
          input
        );
        const limit =
          typeof input.limit === 'number' &&
          Number.isInteger(input.limit) &&
          input.limit > 0
            ? Math.min(input.limit, 1000)
            : 100;
        const response =
          await runtime.client.request<
            LspCompletionItemResponse[] | LspCompletionListResponse
          >('textDocument/completion', {
            textDocument: { uri: document.uri },
            position: { line: line - 1, character: column - 1 },
          });
        const { isIncomplete, items } = normalizeCompletionItems(response);
        const truncated = items.length > limit;
        const resultItems = truncated ? items.slice(0, limit) : items;
        return JSON.stringify(
          {
            query: { filePath: document.uri, line, column },
            isIncomplete,
            items: resultItems,
            truncated,
            totalItems: items.length,
          },
          null,
          2
        );
      },
    });

    // ---------------------------------------------------------------
    // Refactoring (returns edits; never applies them)
    // ---------------------------------------------------------------

    function describeWorkspaceEdit(
      edit: NormalizedWorkspaceEdit
    ): {
      filesTouched: number;
      editCount: number;
      editsByFile: Record<string, number>;
    } {
      const editsByFile: Record<string, number> = {};
      let editCount = 0;
      for (const change of edit.changes) {
        editsByFile[change.filePath] =
          (editsByFile[change.filePath] ?? 0) + change.edits.length;
        editCount += change.edits.length;
      }
      for (const change of edit.documentChanges) {
        if (change.kind !== 'textEdit') {
          continue;
        }
        editsByFile[change.filePath] =
          (editsByFile[change.filePath] ?? 0) + change.edits.length;
        editCount += change.edits.length;
      }
      return {
        filesTouched: Object.keys(editsByFile).length,
        editCount,
        editsByFile,
      };
    }

    const HEAVY_EDIT_BUDGET = 3000;

    registration.registerTool({
      name: 'code_action',
      description:
        'Return LSP code actions (quick fixes, refactorings, source actions) for a file and range. Returns edits as JSON; the LSP plugin never applies them. The agent should review and apply via file.write.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Workspace-relative or absolute file path.',
          },
          startLine: {
            type: 'integer',
            description: '1-based start line of the range.',
          },
          startColumn: {
            type: 'integer',
            description: '1-based start column of the range.',
          },
          endLine: {
            type: 'integer',
            description: '1-based end line of the range.',
          },
          endColumn: {
            type: 'integer',
            description: '1-based end column of the range.',
          },
          only: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of LSP CodeActionKind values to filter by, e.g. ["quickfix", "refactor", "source.fixAll"].',
          },
        },
        required: ['filePath', 'startLine', 'startColumn', 'endLine', 'endColumn'],
        additionalProperties: false,
      },
      execute: async input => {
        const startLine = input.startLine;
        const startColumn = input.startColumn;
        const endLine = input.endLine;
        const endColumn = input.endColumn;
        if (
          typeof startLine !== 'number' ||
          !Number.isInteger(startLine) ||
          startLine <= 0 ||
          typeof startColumn !== 'number' ||
          !Number.isInteger(startColumn) ||
          startColumn <= 0 ||
          typeof endLine !== 'number' ||
          !Number.isInteger(endLine) ||
          endLine <= 0 ||
          typeof endColumn !== 'number' ||
          !Number.isInteger(endColumn) ||
          endColumn <= 0
        ) {
          throw new Error(
            'lsp.code_action requires positive integer line/column values for the range.'
          );
        }
        await refreshWorkspaceIfNeeded();
        if (
          typeof input.filePath !== 'string' ||
          input.filePath.trim().length === 0
        ) {
          throw new Error('lsp.code_action requires a filePath string.');
        }
        const filePath = resolveTargetFilePath(input.filePath);
        const runtime = findRuntimeForFile(filePath);
        if (!runtime) {
          throw new Error(
            `No connected LSP server is available for ${filePath}.`
          );
        }
        const document = await ensureDocumentLoaded(runtime, filePath);
        const only = Array.isArray(input.only)
          ? input.only.filter(
              (value): value is string => typeof value === 'string'
            )
          : undefined;
        const range = {
          start: {
            line: startLine - 1,
            character: startColumn - 1,
          },
          end: {
            line: endLine - 1,
            character: endColumn - 1,
          },
        };
        // Include any diagnostics touching this range so the server can
        // surface relevant quick-fixes.
        const diagnostics = (diagnosticsByFile.get(document.uri) ?? []).filter(
          diagnostic => {
            const ds = diagnostic.range.start;
            const de = diagnostic.range.end;
            if (
              ds.line > range.end.line ||
              (ds.line === range.end.line &&
                ds.character > range.end.character)
            ) {
              return false;
            }
            if (
              de.line < range.start.line ||
              (de.line === range.start.line &&
                de.character < range.start.character)
            ) {
              return false;
            }
            return true;
          }
        );
        const response =
          await runtime.client.request<LspCodeActionResponse[]>(
            'textDocument/codeAction',
            {
              textDocument: { uri: document.uri },
              range,
              context: {
                diagnostics: diagnostics.map(diagnostic => ({
                  range: diagnostic.range,
                  message: diagnostic.message,
                  severity: severityToLsp(diagnostic.severity),
                  source: diagnostic.source,
                  code: diagnostic.code,
                })),
                only,
              },
            }
          );
        const actions = normalizeCodeActions(response);
        const result = actions.map(action => {
          const edit = action.edit;
          if (!edit) {
            return {
              title: action.title,
              kind: action.kind,
              isPreferred: action.isPreferred,
              disabledReason: action.disabledReason,
              requiresServerCommand: action.requiresServerCommand,
              command: action.command,
              edit: null,
            };
          }
          const {
            changes,
            documentChanges,
            truncated,
            totalTokensBefore,
            droppedFiles,
            retainedFiles,
          } = truncateWorkspaceEdit(edit, HEAVY_EDIT_BUDGET);
          return {
            title: action.title,
            kind: action.kind,
            isPreferred: action.isPreferred,
            disabledReason: action.disabledReason,
            requiresServerCommand: action.requiresServerCommand,
            command: action.command,
            edit: {
              changes,
              documentChanges,
              truncated,
              totalTokensBefore,
              droppedFiles,
              retainedFiles,
            },
            summary: describeWorkspaceEdit(edit),
          };
        });
        return JSON.stringify(
          {
            query: { filePath, startLine, startColumn, endLine, endColumn },
            actions: result,
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'rename',
      description:
        'Return the WorkspaceEdit for renaming a symbol across the workspace. Edits are returned as JSON only — the LSP plugin never applies them. The agent should review and apply via file.write.',
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
          newName: {
            type: 'string',
            description: 'The new symbol name.',
          },
        },
        required: ['filePath', 'line', 'column', 'newName'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.newName !== 'string' || input.newName.length === 0) {
          throw new Error('lsp.rename requires a non-empty newName.');
        }
        const { runtime, document, line, column } = await resolveAtPosition(
          'lsp.rename',
          input
        );
        const response =
          await runtime.client.request<LspWorkspaceEdit>(
            'textDocument/rename',
            {
              textDocument: { uri: document.uri },
              position: { line: line - 1, character: column - 1 },
              newName: input.newName,
            }
          );
        const edit = normalizeWorkspaceEdit(response);
        const truncated = truncateWorkspaceEdit(edit, HEAVY_EDIT_BUDGET);
        return JSON.stringify(
          {
            query: {
              filePath: document.uri,
              line,
              column,
              newName: input.newName,
            },
            edit: truncated,
            summary: describeWorkspaceEdit(edit),
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'implementation',
      description:
        'Return locations that implement the interface or method at a position.',
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
        const { runtime, document, line, column } = await resolveAtPosition(
          'lsp.implementation',
          input
        );
        const response =
          await runtime.client.request<DefinitionResponse>(
            'textDocument/implementation',
            {
              textDocument: { uri: document.uri },
              position: { line: line - 1, character: column - 1 },
            }
          );
        const rawLocations = Array.isArray(response)
          ? response
          : response
            ? [response]
            : [];
        const locations = rawLocations
          .map(loc => normalizeLspLocation(loc))
          .filter(
            (loc): loc is NonNullable<typeof loc> => Boolean(loc)
          );
        return JSON.stringify(
          {
            query: { filePath: document.uri, line, column },
            locations: locationToAgentShape(locations),
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'type_definition',
      description:
        'Return the type-definition location(s) for a symbol at a position.',
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
        const { runtime, document, line, column } = await resolveAtPosition(
          'lsp.type_definition',
          input
        );
        const response =
          await runtime.client.request<DefinitionResponse>(
            'textDocument/typeDefinition',
            {
              textDocument: { uri: document.uri },
              position: { line: line - 1, character: column - 1 },
            }
          );
        const rawLocations = Array.isArray(response)
          ? response
          : response
            ? [response]
            : [];
        const locations = rawLocations
          .map(loc => normalizeLspLocation(loc))
          .filter(
            (loc): loc is NonNullable<typeof loc> => Boolean(loc)
          );
        return JSON.stringify(
          {
            query: { filePath: document.uri, line, column },
            locations: locationToAgentShape(locations),
          },
          null,
          2
        );
      },
    });

    // ---------------------------------------------------------------
    // Call hierarchy
    // ---------------------------------------------------------------

    async function resolveCallHierarchy(
      toolName: string,
      input: Record<string, unknown>
    ): Promise<{
      runtime: ServerRuntime;
      document: DocumentState;
      item: NormalizedCallHierarchyItem;
      line: number;
      column: number;
    }> {
      const { runtime, document, line, column } = await resolveAtPosition(
        toolName,
        input
      );
      const response =
        await runtime.client.request<LspCallHierarchyItem[]>(
          'textDocument/prepareCallHierarchy',
          {
            textDocument: { uri: document.uri },
            position: { line: line - 1, character: column - 1 },
          }
        );
      const item = normalizeCallHierarchyItem(response?.[0]);
      if (!item) {
        throw new Error(
          `${toolName}: no call-hierarchy item at the given position.`
        );
      }
      return { runtime, document, item, line, column };
    }

    registration.registerTool({
      name: 'call_hierarchy_incoming',
      description:
        'Return the call hierarchy chain of callers leading to the symbol at a position.',
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
        const { runtime, item } = await resolveCallHierarchy(
          'lsp.call_hierarchy_incoming',
          input
        );
        const response =
          await runtime.client.request<LspCallHierarchyCall[]>(
            'callHierarchy/incomingCalls',
            { item: callHierarchyItemToLsp(item) }
          );
        const { from } = normalizeCallHierarchyCalls(response);
        return JSON.stringify(
          {
            query: {
              item,
              direction: 'incoming',
            },
            from,
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'call_hierarchy_outgoing',
      description:
        'Return the call hierarchy chain of callees invoked by the symbol at a position.',
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
        const { runtime, item } = await resolveCallHierarchy(
          'lsp.call_hierarchy_outgoing',
          input
        );
        const response =
          await runtime.client.request<LspCallHierarchyCall[]>(
            'callHierarchy/outgoingCalls',
            { item: callHierarchyItemToLsp(item) }
          );
        const { to } = normalizeCallHierarchyCalls(response);
        return JSON.stringify(
          {
            query: {
              item,
              direction: 'outgoing',
            },
            to,
          },
          null,
          2
        );
      },
    });

    function callHierarchyItemToLsp(
      item: NormalizedCallHierarchyItem
    ): LspCallHierarchyItem {
      return {
        name: item.name,
        kind: item.kind,
        detail: item.detail,
        uri: toFileUri(item.filePath),
        range: {
          start: {
            line: item.line - 1,
            character: item.column - 1,
          },
          end: {
            line: item.endLine - 1,
            character: item.endColumn - 1,
          },
        },
        selectionRange: {
          start: {
            line: item.line - 1,
            character: item.column - 1,
          },
          end: {
            line: item.endLine - 1,
            character: item.endColumn - 1,
          },
        },
      };
    }

    // ---------------------------------------------------------------
    // Formatting (truncated)
    // ---------------------------------------------------------------

    registration.registerTool({
      name: 'formatting',
      description:
        'Return LSP whole-file formatting edits for a single file. Returns edits as JSON; the LSP plugin never applies them. If the response would be too large it is truncated with head/tail previews per edit.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Workspace-relative or absolute file path.',
          },
          tabSize: {
            type: 'integer',
            description:
              'Optional tab size hint forwarded to the server.',
          },
          insertSpaces: {
            type: 'boolean',
            description:
              'Optional space-vs-tabs hint forwarded to the server.',
          },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
      execute: async input => {
        if (
          typeof input.filePath !== 'string' ||
          input.filePath.trim().length === 0
        ) {
          throw new Error('lsp.formatting requires a filePath string.');
        }
        await refreshWorkspaceIfNeeded();
        const filePath = resolveTargetFilePath(input.filePath);
        const runtime = findRuntimeForFile(filePath);
        if (!runtime) {
          throw new Error(
            `No connected LSP server is available for ${filePath}.`
          );
        }
        const document = await ensureDocumentLoaded(runtime, filePath);
        const options: {
          tabSize?: number;
          insertSpaces?: boolean;
        } = {};
        if (
          typeof input.tabSize === 'number' &&
          Number.isInteger(input.tabSize) &&
          input.tabSize > 0
        ) {
          options.tabSize = input.tabSize;
        }
        if (typeof input.insertSpaces === 'boolean') {
          options.insertSpaces = input.insertSpaces;
        }
        const response =
          await runtime.client.request<
            Array<{ range?: LspRangeResponse; newText?: string }>
          >('textDocument/formatting', {
            textDocument: { uri: document.uri },
            options,
          });
        const edits = normalizeTextEdits(response);
        const wrapped: NormalizedWorkspaceEdit = {
          changes: [
            { filePath, edits },
          ],
          documentChanges: [],
        };
        const truncated = truncateWorkspaceEdit(
          wrapped,
          HEAVY_EDIT_BUDGET
        );
        return JSON.stringify(
          {
            query: { filePath },
            edit: truncated,
            summary: describeWorkspaceEdit(wrapped),
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

import { isRecord } from '../../shared/type-guards.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DroneLspDiagnostic } from 'drone-core';

// ---------------------------------------------------------------------------
// LSP response shapes (from the LSP 3.17 spec)
// ---------------------------------------------------------------------------

export type LspRangeResponse = {
  start?: { line?: number; character?: number };
  end?: { line?: number; character?: number };
};

export type LspLocationResponse = {
  uri?: string;
  range?: LspRangeResponse;
};

export type LspLocationLinkResponse = {
  targetUri?: string;
  targetRange?: LspRangeResponse;
  targetSelectionRange?: LspRangeResponse;
  originSelectionRange?: LspRangeResponse;
};

export type HoverResponse = {
  contents?: unknown;
  range?: LspRangeResponse;
} | null;

export type DefinitionResponse =
  | LspLocationResponse
  | LspLocationResponse[]
  | LspLocationLinkResponse[]
  | null;

export type ReferencesResponse = LspLocationResponse[] | null;

export type PublishDiagnosticsParams = {
  uri?: string;
  diagnostics?: Array<{
    range?: LspRangeResponse;
    severity?: number;
    message?: string;
    source?: string;
    code?: string | number;
  }>;
};

export type LspDocumentSymbolResponse = {
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

export type LspWorkspaceSymbolResponse = {
  name?: string;
  kind?: number | string;
  tags?: Array<number | string>;
  containerName?: string;
  location?: {
    uri?: string;
    range?: LspRangeResponse;
  };
};

export type LspParameterInformation = {
  label?: string | [number, number];
  documentation?: unknown;
};

export type LspSignatureInformation = {
  label?: string;
  documentation?: unknown;
  parameters?: LspParameterInformation[];
  activeParameter?: number;
};

export type LspSignatureHelpResponse = {
  signatures?: LspSignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
};

export type LspCompletionItemResponse = {
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

export type LspCompletionListResponse = {
  isIncomplete?: boolean;
  items?: LspCompletionItemResponse[];
};

export type LspCommandResponse = {
  title?: string;
  command?: string;
  arguments?: unknown[];
};

export type LspCodeActionResponse = {
  title?: string;
  kind?: string;
  diagnostics?: Array<{ code?: string | number }>;
  isPreferred?: boolean;
  disabled?: { reason?: string };
  edit?: LspWorkspaceEdit;
  command?: LspCommandResponse;
};

export type LspWorkspaceEdit = {
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
export type LspDocumentChange =
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

export type LspCallHierarchyItem = {
  name?: string;
  kind?: number | string;
  detail?: string;
  uri?: string;
  range?: LspRangeResponse;
  selectionRange?: LspRangeResponse;
};

export type LspCallHierarchyCall = {
  from?: LspCallHierarchyItem[];
  to?: LspCallHierarchyItem[];
};

// ---------------------------------------------------------------------------
// Normalized (agent-facing) types
// ---------------------------------------------------------------------------

export type NormalizedSymbol = {
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

export type NormalizedSignatureHelp = {
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

export type NormalizedCompletionItem = {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
  insertText?: string;
};

export type NormalizedTextEdit = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
};

export type NormalizedWorkspaceEdit = {
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

export type NormalizedCodeAction = {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabledReason?: string;
  edit?: NormalizedWorkspaceEdit;
  command?: { title?: string; command?: string };
  /** True if the action's effects aren't fully captured in the edit and
   * would need server-side execution. Agents should be cautious about
   * these. */
  requiresServerCommand: boolean;
};

export type NormalizedCallHierarchyItem = {
  name: string;
  kind: string;
  detail?: string;
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

// ---------------------------------------------------------------------------
// Symbol kind lookup tables (LSP 3.17 spec)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { isRecord };
export function normalizeFileExtensions(fileExtensions: string[]): string[] {
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

// ---------------------------------------------------------------------------
// URI / path helpers
// ---------------------------------------------------------------------------

export function toFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

export function fromFileUri(uri: string): string | null {
  try {
    return path.resolve(fileURLToPath(uri));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export function normalizeSeverity(
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

export function severityToLsp(
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

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

export function normalizeHoverContents(contents: unknown): string {
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

// ---------------------------------------------------------------------------
// Range / location
// ---------------------------------------------------------------------------

export function normalizeLspRange(range: LspRangeResponse | undefined): {
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

export function normalizeLspLocation(
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

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 1;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

// ---------------------------------------------------------------------------
// Diagnostic sorting
// ---------------------------------------------------------------------------

export function sortDiagnostics(
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
// Symbol kind formatting
// ---------------------------------------------------------------------------

export function formatSymbolKind(kind: number | string | undefined): string {
  if (kind === undefined) {
    return 'Unknown';
  }
  if (typeof kind === 'string') {
    return kind;
  }
  return LSP_SYMBOL_KIND[kind] ?? `kind:${kind}`;
}

export function formatCompletionKind(
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

// ---------------------------------------------------------------------------
// Markup content
// ---------------------------------------------------------------------------

export function normalizeMarkupContent(value: unknown): string {
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

// ---------------------------------------------------------------------------
// Document symbols
// ---------------------------------------------------------------------------

export function flattenDocumentSymbols(
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
      detail: typeof symbol.detail === 'string' ? symbol.detail : undefined,
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

// ---------------------------------------------------------------------------
// Workspace symbols
// ---------------------------------------------------------------------------

export function normalizeWorkspaceSymbols(
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
    const filePath = typeof uri === 'string' ? fromFileUri(uri) : undefined;
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
      deprecated: Array.isArray(symbol.tags) && symbol.tags.includes(1),
    };
    out.push(normalized);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signature help
// ---------------------------------------------------------------------------

export function normalizeSignatureHelp(
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
              documentation: normalizeMarkupContent(parameter.documentation),
            };
          }),
          activeParameter,
        };
      }),
  };
}

// ---------------------------------------------------------------------------
// Completion items
// ---------------------------------------------------------------------------

export function normalizeCompletionItems(
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
      sortText: typeof item.sortText === 'string' ? item.sortText : undefined,
      filterText:
        typeof item.filterText === 'string' ? item.filterText : undefined,
      insertText:
        typeof item.insertText === 'string' ? item.insertText : undefined,
    });
  }
  return { isIncomplete, items };
}

// ---------------------------------------------------------------------------
// Text edits
// ---------------------------------------------------------------------------

export function normalizeTextEdits(
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

// ---------------------------------------------------------------------------
// Workspace edit
// ---------------------------------------------------------------------------

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

export function normalizeWorkspaceEdit(
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
        typeof change.oldUri === 'string' ? fromFileUri(change.oldUri) : null;
      const newPath =
        typeof change.newUri === 'string' ? fromFileUri(change.newUri) : null;
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

// ---------------------------------------------------------------------------
// Code actions
// ---------------------------------------------------------------------------

export function normalizeCodeActions(
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

// ---------------------------------------------------------------------------
// Call hierarchy
// ---------------------------------------------------------------------------

export function normalizeCallHierarchyItem(
  item: LspCallHierarchyItem | null | undefined
): NormalizedCallHierarchyItem | null {
  if (!item || typeof item.name !== 'string') {
    return null;
  }
  const filePath = typeof item.uri === 'string' ? fromFileUri(item.uri) : null;
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
    endColumn: (range?.end?.character ?? range?.start?.character ?? 0) + 1,
  };
}

export function normalizeCallHierarchyCalls(
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

export function callHierarchyItemToLsp(
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

// ---------------------------------------------------------------------------
// Workspace edit truncation (token-budget-aware)
// ---------------------------------------------------------------------------

/**
 * Truncate a WorkspaceEdit so the serialized JSON fits within a token
 * budget. Past the budget, we drop the `edits[]` payload but keep the
 * file list — so the agent still sees which files would change and
 * can decide whether to fetch each one via file.read for the diff. The
 * dropped-files set is reported as `droppedFiles` so the agent knows
 * exactly what it's missing.
 */
export function truncateWorkspaceEdit(
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
    return retainedSet.has(change.filePath) ? change : { ...change, edits: [] };
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

export function describeWorkspaceEdit(edit: NormalizedWorkspaceEdit): {
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

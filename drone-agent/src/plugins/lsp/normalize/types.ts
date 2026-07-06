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

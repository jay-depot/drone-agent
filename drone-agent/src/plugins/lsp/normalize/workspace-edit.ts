import type {
  LspRangeResponse,
  LspWorkspaceEdit,
  LspDocumentChange,
  LspCodeActionResponse,
  NormalizedTextEdit,
  NormalizedWorkspaceEdit,
  NormalizedCodeAction,
} from './types.js';
import { normalizeLspRange } from './range.js';
import { fromFileUri } from './uri.js';

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

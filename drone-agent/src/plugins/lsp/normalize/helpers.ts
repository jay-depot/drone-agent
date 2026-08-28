import type { DroneLspDiagnostic } from 'drone-core';
import { isRecord } from '../../../shared/type-guards.js';

export { isRecord };

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

export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 1;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

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

export function truncateWorkspaceEdit(
  edit: import('./types.js').NormalizedWorkspaceEdit,
  tokenBudget: number
): import('./types.js').NormalizedWorkspaceEdit & {
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
  let consumedTokens: number;
  const baseTokens = (() => {
    // Cost of the response shell with all file edits emptied.
    const empty: import('./types.js').NormalizedWorkspaceEdit = {
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

export function describeWorkspaceEdit(
  edit: import('./types.js').NormalizedWorkspaceEdit
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

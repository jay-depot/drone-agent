import type {
  LspCallHierarchyItem,
  LspCallHierarchyCall,
  NormalizedCallHierarchyItem,
} from './types.js';
import { formatSymbolKind } from './symbols.js';
import { fromFileUri, toFileUri } from './uri.js';

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

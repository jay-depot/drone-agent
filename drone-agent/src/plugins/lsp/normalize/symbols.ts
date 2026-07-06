import type {
  LspDocumentSymbolResponse,
  LspWorkspaceSymbolResponse,
  NormalizedSymbol,
} from './types.js';
import { fromFileUri } from './uri.js';

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

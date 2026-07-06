import type {
  LspCompletionItemResponse,
  LspCompletionListResponse,
  NormalizedCompletionItem,
} from './types.js';
import { formatCompletionKind } from './symbols.js';
import { normalizeMarkupContent } from './helpers.js';

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

import type { LspRangeResponse, LspLocationResponse, LspLocationLinkResponse } from './types.js';
import { fromFileUri } from './uri.js';

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

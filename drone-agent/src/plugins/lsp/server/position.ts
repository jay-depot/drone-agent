import path from 'node:path';
import {
  AmbiguousPositionError,
  buildAmbiguousMatches,
  HARD_CONTEXT_LINES,
} from 'drone-core';
import {
  filterSymbolsByQuery,
  flattenDocumentSymbols,
  normalizeWorkspaceSymbols,
  type LspDocumentSymbolResponse,
  type LspWorkspaceSymbolResponse,
  type NormalizedSymbol,
} from '../normalize/index.js';
import { readDocumentSnapshot } from './helpers.js';

export type PositionDocument = {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  mtimeMs: number;
  size: number;
};

export type PositionRuntime = {
  id: string;
  language: string;
  client: {
    request: <T>(method: string, params?: unknown) => Promise<T>;
  };
};

export type ResolvedLineColumn = { line: number; column: number };

export type PositionContext = {
  requireRuntimeForFile: (filePath: string) => Promise<PositionRuntime>;
  ensureDocumentLoaded: (
    runtime: PositionRuntime,
    filePath: string
  ) => Promise<PositionDocument>;
  readLineFingerprint: (
    filePath: string,
    line: number
  ) => Promise<string | undefined>;
};

/**
 * Check whether a handed-back surroundingText block appears as a contiguous
 * run of trimmed lines within a window around a 1-based line. The window is
 * sized to the block's line count (capped at HARD_CONTEXT_LINES), so a
 * suggested block is always found when passed back. Matching is exact,
 * modulo leading/trailing whitespace (trim only).
 */
export function matchesSurroundingBlock(
  lines: string[],
  line: number,
  surroundingText: string
): boolean {
  const blockLines = surroundingText.split('\n').map(l => l.trim());
  if (blockLines.length === 0) {
    return false;
  }
  const window = Math.min(blockLines.length, HARD_CONTEXT_LINES);
  const start = Math.max(0, line - 1 - window);
  const end = Math.min(lines.length, line + window);
  const windowLines = lines.slice(start, end).map(l => l.trim());
  outer: for (let i = 0; i + blockLines.length <= windowLines.length; i++) {
    for (let j = 0; j < blockLines.length; j++) {
      if (windowLines[i + j] !== blockLines[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/**
 * Search file content for a text snippet and return its 1-based position.
 * Supports surroundingText for disambiguation when multiple matches exist.
 *
 * 1. Exact match (case-sensitive) first
 * 2. Fall back to case-insensitive if no exact match
 * 3. If surroundingText is provided, filter matches by context
 * 4. If exactly one match (after filtering), return `{ line, column }` (1-based)
 * 5. If multiple matches, throw with each position + 2 lines of context
 * 6. If no matches, throw
 */
export async function resolveTextPosition(
  ctx: PositionContext,
  filePath: string,
  text: string,
  surroundingText?: string
): Promise<ResolvedLineColumn> {
  const absolutePath = path.resolve(filePath);
  const snapshot = await readDocumentSnapshot(absolutePath);
  if (!snapshot) {
    throw new Error(`Could not read file: ${absolutePath}`);
  }

  const lines = snapshot.text.split('\n');
  const matches: Array<{
    line: number;
    column: number;
    context: string;
  }> = [];

  // Case-sensitive search
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(text);
    if (col !== -1) {
      const contextLines = lines.slice(
        Math.max(0, i - 2),
        Math.min(lines.length, i + 3)
      );
      matches.push({
        line: i + 1,
        column: col + 1,
        context: contextLines.join('\n'),
      });
    }
  }

  // Fall back to case-insensitive if no exact matches
  if (matches.length === 0) {
    const lowerText = text.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const col = lines[i].toLowerCase().indexOf(lowerText);
      if (col !== -1) {
        const contextLines = lines.slice(
          Math.max(0, i - 2),
          Math.min(lines.length, i + 3)
        );
        matches.push({
          line: i + 1,
          column: col + 1,
          context: contextLines.join('\n'),
        });
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(`Text "${text}" not found in ${absolutePath}.`);
  }

  if (surroundingText && matches.length > 1) {
    const filteredMatches = matches.filter(m =>
      matchesSurroundingBlock(lines, m.line, surroundingText)
    );
    if (filteredMatches.length === 1) {
      return {
        line: filteredMatches[0].line,
        column: filteredMatches[0].column,
      };
    }
    if (filteredMatches.length > 1) {
      matches.length = 0;
      matches.push(...filteredMatches);
    }
  }

  if (matches.length > 1) {
    const ambiguousMatches = await buildAmbiguousMatches(
      matches.map(m => ({
        filePath: absolutePath,
        line: m.line,
        column: m.column,
      })),
      async filePath => {
        const snap = filePath === absolutePath ? snapshot : undefined;
        return snap ? snap.text.split('\n') : undefined;
      }
    );
    const details = ambiguousMatches
      .map(
        (m, idx) =>
          `  ${idx + 1}. Line ${m.line}, column ${m.column}:\n${m.context
            .split('\n')
            .map(l => `     ${l}`)
            .join('\n')}`
      )
      .join('\n');
    throw new AmbiguousPositionError(
      absolutePath,
      ambiguousMatches,
      `Text "${text}" is ambiguous — found ${matches.length} matches in ${absolutePath}:\n${details}`
    );
  }

  return { line: matches[0].line, column: matches[0].column };
}

/**
 * Search for a symbol by name and return its 1-based position.
 *
 * 1. Try `textDocument/documentSymbol` on the file's runtime
 * 2. Search for exact name match, fall back to prefix match
 * 3. Filter out symbols without position info
 * 4. If no match, try `workspace/symbol` on the runtime
 * 5. If exactly one match, return `{ line, column }` (1-based)
 * 6. If multiple matches, throw with context
 * 7. If no matches, throw
 */
export async function resolveSymbolPosition(
  ctx: PositionContext,
  filePath: string,
  symbol: string,
  surroundingText?: string
): Promise<ResolvedLineColumn> {
  const absolutePath = path.resolve(filePath);
  const runtime = await ctx.requireRuntimeForFile(absolutePath);
  const document = await ctx.ensureDocumentLoaded(runtime, absolutePath);

  const docSymbols = await runtime.client.request<LspDocumentSymbolResponse[]>(
    'textDocument/documentSymbol',
    { textDocument: { uri: document.uri } }
  );
  const flat = flattenDocumentSymbols(docSymbols);
  const candidates = filterSymbolsByQuery(flat, symbol);

  const withPosition = candidates.filter(
    (s): s is NormalizedSymbol & { line: number; column: number } =>
      s.line !== undefined && s.column !== undefined
  );

  if (withPosition.length === 1) {
    return { line: withPosition[0].line, column: withPosition[0].column };
  }
  const snapshot = await readDocumentSnapshot(absolutePath);

  if (surroundingText && withPosition.length > 1) {
    if (snapshot) {
      const lines = snapshot.text.split('\n');
      const filtered = withPosition.filter(s =>
        matchesSurroundingBlock(lines, s.line, surroundingText)
      );
      if (filtered.length === 1) {
        return { line: filtered[0].line, column: filtered[0].column };
      }
      if (filtered.length > 1) {
        withPosition.length = 0;
        withPosition.push(...filtered);
      }
    }
  }

  if (withPosition.length > 1) {
    const ambiguousMatches = await buildAmbiguousMatches(
      withPosition.map(s => ({
        filePath: absolutePath,
        line: s.line,
        column: s.column,
      })),
      async filePath => {
        if (filePath !== absolutePath) return undefined;
        return snapshot ? snapshot.text.split('\n') : undefined;
      }
    );
    const details = ambiguousMatches
      .map((m, idx) => {
        const orig = withPosition[idx];
        return `  ${idx + 1}. Line ${m.line}, column ${m.column} — ${orig?.name ?? ''}`;
      })
      .join('\n');
    throw new AmbiguousPositionError(
      absolutePath,
      ambiguousMatches,
      `Symbol "${symbol}" is ambiguous — found ${withPosition.length} matches in ${absolutePath}:\n${details}`
    );
  }

  const wsSymbols = await runtime.client.request<LspWorkspaceSymbolResponse[]>(
    'workspace/symbol',
    { query: symbol }
  );
  const wsFlat = normalizeWorkspaceSymbols(wsSymbols);
  const wsCandidates = filterSymbolsByQuery(wsFlat, symbol);

  const wsWithPosition = wsCandidates.filter(
    (
      s
    ): s is NormalizedSymbol & {
      filePath: string;
      line: number;
      column: number;
    } =>
      s.line !== undefined && s.column !== undefined && s.filePath !== undefined
  );

  if (wsWithPosition.length === 0) {
    throw new Error(`Symbol "${symbol}" not found in workspace.`);
  }

  if (wsWithPosition.length === 1) {
    return {
      line: wsWithPosition[0].line,
      column: wsWithPosition[0].column,
    };
  }

  if (surroundingText && wsWithPosition.length > 1) {
    const filtered: Array<
      NormalizedSymbol & { filePath: string; line: number; column: number }
    > = [];
    for (const s of wsWithPosition) {
      const snap = await readDocumentSnapshot(s.filePath);
      if (!snap) continue;
      const lines = snap.text.split('\n');
      if (matchesSurroundingBlock(lines, s.line, surroundingText)) {
        filtered.push(s);
      }
    }
    if (filtered.length === 1) {
      return {
        line: filtered[0].line,
        column: filtered[0].column,
      };
    }
    if (filtered.length > 1) {
      wsWithPosition.length = 0;
      wsWithPosition.push(...filtered);
    }
  }

  const ambiguousMatches = await buildAmbiguousMatches(
    wsWithPosition.map(s => ({
      filePath: s.filePath,
      line: s.line,
      column: s.column,
    })),
    async filePath => {
      const snap = await readDocumentSnapshot(filePath);
      return snap ? snap.text.split('\n') : undefined;
    }
  );
  const details = wsWithPosition
    .map(
      (s, idx) =>
        `  ${idx + 1}. ${s.filePath}:${s.line}:${s.column} — ${s.name}`
    )
    .join('\n');
  throw new AmbiguousPositionError(
    undefined, // Workspace ambiguity has no single file
    ambiguousMatches,
    `Symbol "${symbol}" is ambiguous across the workspace — found ${wsWithPosition.length} matches:\n${details}`
  );
}

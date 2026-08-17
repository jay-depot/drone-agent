import { readFile, writeFile } from 'node:fs/promises';
import type { DroneToolDefinition } from 'drone-core';
import type { DroneLspDiagnostic } from 'drone-core';
import { AmbiguousPositionError, type AmbiguousMatch } from 'drone-core';
import type { ServerManager, ResolvedPosition } from '../server.js';
import {
  normalizeTextEdits,
  normalizeWorkspaceEdit,
  normalizeCodeActions,
  truncateWorkspaceEdit,
  describeWorkspaceEdit,
  severityToLsp,
  type LspCodeActionResponse,
  type LspWorkspaceEdit,
} from '../normalize/index.js';

const HEAVY_EDIT_BUDGET = 3000;
const CRIB_SHEET_CONTEXT_LINES = 5;

/**
 * Build a crib-sheet entry for an ambiguous match: the reference ID,
 * position, context snippet, and suggested surroundingText that would
 * uniquely target this match.
 */
async function buildCribSheetEntry(
  server: ServerManager,
  match: AmbiguousMatch,
  referenceId: string
): Promise<Record<string, unknown>> {
  const snippet = await server.readFileSnippet(
    match.filePath,
    match.line,
    CRIB_SHEET_CONTEXT_LINES
  );
  return {
    referenceId,
    filePath: match.filePath,
    line: match.line,
    column: match.column,
    suggestedContext: match.suggestedContext,
    snippet: snippet || undefined,
    context: match.context,
  };
}

/**
 * Convert an AmbiguousPositionError into a response that returns
 * reference IDs paired with crib sheets so the LLM can confirm which
 * match to target.
 */
async function buildAmbiguousResponse(
  server: ServerManager,
  error: AmbiguousPositionError
): Promise<string> {
  const locations = await Promise.all(
    error.matches.map(async m => ({
      filePath: m.filePath,
      line: m.line,
      column: m.column,
      range: {
        start: { line: m.line - 1, character: m.column - 1 },
        end: { line: m.line - 1, character: m.column },
      },
      fingerprint: (await server.readLineFingerprint(m.filePath, m.line)) ?? '',
    }))
  );
  const referenceIds = await server.storeReferences(locations);
  const cribSheet = await Promise.all(
    error.matches.map((m, i) => buildCribSheetEntry(server, m, referenceIds[i]))
  );
  return JSON.stringify(
    {
      error: error.message,
      ambiguous: true,
      hint: 'Provide a referenceId from the list below to confirm which match to target.',
      matches: cribSheet,
    },
    null,
    2
  );
}

/**
 * Build a structured response telling the LLM that a reference ID is stale
 * (the underlying file line changed or the file is gone) and it should
 * re-resolve the position to get fresh reference IDs.
 */
function buildStaleResponse(referenceId: string): string {
  return JSON.stringify(
    {
      stale: true,
      referenceId,
      hint: 'Re-resolve the position to get fresh reference IDs.',
    },
    null,
    2
  );
}

export function createCodeActionTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'code_action',
    description:
      'Return LSP code actions (quick fixes, refactorings, source actions) for a file and range. When no range is specified, returns all actions for the file. Use text or symbol to target a specific position. If text/symbol resolution is ambiguous, a list of reference IDs with code snippets will be returned — re-invoke with a referenceId to confirm the target. If a referenceId is stale (the file changed), a stale response is returned — re-resolve the position for fresh reference IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        startLine: {
          type: 'integer',
          description:
            '1-based start line of the range (optional if text/symbol/referenceId is provided, or to get all actions).',
        },
        startColumn: {
          type: 'integer',
          description:
            '1-based start column of the range (optional if text/symbol/referenceId is provided, or to get all actions).',
        },
        endLine: {
          type: 'integer',
          description:
            '1-based end line of the range (optional if text/symbol/referenceId is provided, or to get all actions).',
        },
        endColumn: {
          type: 'integer',
          description:
            '1-based end column of the range (optional if text/symbol/referenceId is provided, or to get all actions).',
        },
        text: {
          type: 'string',
          description:
            'Text content to target code actions at (alternative to range).',
        },
        symbol: {
          type: 'string',
          description:
            'Symbol name to target code actions at (alternative to range).',
        },
        surroundingText: {
          type: 'string',
          description:
            'Surrounding context text to disambiguate between multiple matches (e.g., "class User {"). Works with text and symbol.',
        },
        referenceId: {
          type: 'string',
          description:
            'A reference ID from a previous ambiguous resolution. Use this to confirm which match to target after receiving reference IDs.',
        },
        only: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of LSP CodeActionKind values to filter by, e.g. ["quickfix", "refactor", "source.fixAll"].',
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
        throw new Error('lsp.code_action requires a filePath string.');
      }
      await server.refreshIfNeeded();
      const filePath = server.resolveTargetFilePath(input.filePath);

      // If text/symbol is provided (and no referenceId), attempt position
      // resolution first so ambiguity can be reported with reference IDs even
      // without a connected runtime (parsePositionInput only reads files).
      // When a referenceId is present it takes precedence, so skip the pre-pass
      // to avoid an ambiguous text parse overriding the caller's explicit choice.
      if (
        !input.referenceId &&
        (typeof input.text === 'string' || typeof input.symbol === 'string')
      ) {
        try {
          await server.parsePositionInput('lsp__code_action', input);
        } catch (error) {
          if (error instanceof AmbiguousPositionError) {
            return buildAmbiguousResponse(server, error);
          }
          throw error;
        }
      }

      const only = Array.isArray(input.only)
        ? input.only.filter(
            (value): value is string => typeof value === 'string'
          )
        : undefined;

      // Determine range and diagnostics based on input
      let range:
        | {
            start: { line: number; character: number };
            end: { line: number; character: number };
          }
        | undefined;
      let diagnostics: DroneLspDiagnostic[];
      let targetFilePath = filePath;

      if (typeof input.referenceId === 'string') {
        // Resolve from reference ID
        const resolution = await server.resolveReference(input.referenceId);
        if (!resolution) {
          throw new Error(
            `Reference ID "${input.referenceId}" not found. It may have expired. Please resolve the position again.`
          );
        }
        if (resolution.stale) {
          return buildStaleResponse(input.referenceId);
        }
        const ref = resolution.location;
        targetFilePath = ref.filePath;
        range = {
          start: ref.range.start,
          end: {
            line: ref.range.start.line,
            character: ref.range.start.character + 1,
          },
        };
        diagnostics = server.getDiagnostics().filter(d => {
          if (d.filePath !== targetFilePath) return false;
          const ds = d.range.start;
          const de = d.range.end;
          if (
            ds.line > range!.end.line ||
            (ds.line === range!.end.line && ds.character > range!.end.character)
          ) {
            return false;
          }
          if (
            de.line < range!.start.line ||
            (de.line === range!.start.line &&
              de.character < range!.start.character)
          ) {
            return false;
          }
          return true;
        });
      } else if (
        typeof input.text === 'string' ||
        typeof input.symbol === 'string'
      ) {
        // Resolve position from text/symbol, build a single-character range
        let pos: { filePath: string; line: number; column: number };
        try {
          pos = await server.parsePositionInput('lsp__code_action', input);
        } catch (error) {
          if (error instanceof AmbiguousPositionError) {
            return buildAmbiguousResponse(server, error);
          }
          throw error;
        }
        range = {
          start: { line: pos.line - 1, character: pos.column - 1 },
          end: { line: pos.line - 1, character: pos.column },
        };
        diagnostics = server.getDiagnostics().filter(d => {
          if (d.filePath !== filePath) return false;
          const ds = d.range.start;
          const de = d.range.end;
          if (
            ds.line > range!.end.line ||
            (ds.line === range!.end.line && ds.character > range!.end.character)
          ) {
            return false;
          }
          if (
            de.line < range!.start.line ||
            (de.line === range!.start.line &&
              de.character < range!.start.character)
          ) {
            return false;
          }
          return true;
        });
      } else if (
        typeof input.startLine === 'number' &&
        typeof input.startColumn === 'number' &&
        typeof input.endLine === 'number' &&
        typeof input.endColumn === 'number'
      ) {
        // Traditional range
        const startLine = input.startLine;
        const startColumn = input.startColumn;
        const endLine = input.endLine;
        const endColumn = input.endColumn;
        if (
          !Number.isInteger(startLine) ||
          startLine <= 0 ||
          !Number.isInteger(startColumn) ||
          startColumn <= 0 ||
          !Number.isInteger(endLine) ||
          endLine <= 0 ||
          !Number.isInteger(endColumn) ||
          endColumn <= 0
        ) {
          throw new Error(
            'lsp.code_action requires positive integer line/column values for the range.'
          );
        }
        range = {
          start: { line: startLine - 1, character: startColumn - 1 },
          end: { line: endLine - 1, character: endColumn - 1 },
        };
        diagnostics = server.getDiagnostics().filter(d => {
          if (d.filePath !== filePath) return false;
          const ds = d.range.start;
          const de = d.range.end;
          if (
            ds.line > range!.end.line ||
            (ds.line === range!.end.line && ds.character > range!.end.character)
          ) {
            return false;
          }
          if (
            de.line < range!.start.line ||
            (de.line === range!.start.line &&
              de.character < range!.start.character)
          ) {
            return false;
          }
          return true;
        });
      } else {
        // No range — return all actions for file
        range = undefined;
        diagnostics = server
          .getDiagnostics()
          .filter(d => d.filePath === filePath);
      }

      const runtime = server.findRuntimeForFile(targetFilePath);
      if (!runtime) {
        throw new Error(
          `No connected LSP server is available for ${targetFilePath}.`
        );
      }
      const document = await server.ensureDocumentLoaded(
        runtime,
        targetFilePath
      );

      const response = await runtime.client.request<LspCodeActionResponse[]>(
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
        const truncated = truncateWorkspaceEdit(edit, HEAVY_EDIT_BUDGET);
        return {
          title: action.title,
          kind: action.kind,
          isPreferred: action.isPreferred,
          disabledReason: action.disabledReason,
          requiresServerCommand: action.requiresServerCommand,
          command: action.command,
          edit: truncated,
          summary: describeWorkspaceEdit(edit),
        };
      });
      return JSON.stringify(
        {
          query: { filePath, range },
          actions: result,
        },
        null,
        2
      );
    },
  };
}

export function createRenameTool(server: ServerManager): DroneToolDefinition {
  return {
    name: 'rename',
    description:
      'Rename a symbol across the workspace. Returns the workspace edit as JSON by default. When apply is true, applies the rename directly. If text/symbol resolution is ambiguous, a list of reference IDs with code snippets will be returned — re-invoke with a referenceId to confirm the target. If a referenceId is stale (the file changed), a stale response is returned — re-resolve the position for fresh reference IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        line: {
          type: 'integer',
          description:
            '1-based line number (optional if text, symbol, or referenceId is provided).',
        },
        column: {
          type: 'integer',
          description:
            '1-based column number (optional if text, symbol, or referenceId is provided).',
        },
        text: {
          type: 'string',
          description:
            'Text content to search for in the file (alternative to line/column).',
        },
        symbol: {
          type: 'string',
          description: 'Symbol name to resolve (alternative to line/column).',
        },
        surroundingText: {
          type: 'string',
          description:
            'Surrounding context text to disambiguate between multiple matches (e.g., "class User {"). Works with text and symbol.',
        },
        referenceId: {
          type: 'string',
          description:
            'A reference ID from a previous ambiguous resolution. Use this to confirm which match to rename after receiving reference IDs.',
        },
        newName: {
          type: 'string',
          description: 'The new symbol name.',
        },
        apply: {
          type: 'boolean',
          description:
            'When true, apply the rename edits directly. Default: false.',
        },
      },
      required: ['filePath', 'newName'],
      additionalProperties: false,
    },
    execute: async input => {
      if (typeof input.newName !== 'string' || input.newName.length === 0) {
        throw new Error('lsp.rename requires a non-empty newName.');
      }
      await server.refreshIfNeeded();

      // If referenceId is provided, resolve it directly
      let resolved: ResolvedPosition;
      if (typeof input.referenceId === 'string') {
        const resolution = await server.resolveReference(input.referenceId);
        if (!resolution) {
          throw new Error(
            `Reference ID "${input.referenceId}" not found. It may have expired. Please resolve the position again.`
          );
        }
        if (resolution.stale) {
          return buildStaleResponse(input.referenceId);
        }
        const ref = resolution.location;
        const filePath = ref.filePath;
        const runtime = server.findRuntimeForFile(filePath);
        if (!runtime) {
          throw new Error(
            `No connected LSP server is available for ${filePath}.`
          );
        }
        const document = await server.ensureDocumentLoaded(runtime, filePath);
        resolved = {
          runtime,
          document,
          line: ref.line,
          column: ref.column,
        };
      } else {
        // Try to resolve position normally; if ambiguous, return reference IDs
        try {
          resolved = await server.resolveAtPosition('lsp__rename', input);
        } catch (error) {
          if (error instanceof AmbiguousPositionError) {
            return buildAmbiguousResponse(server, error);
          }
          throw error;
        }
      }

      const response = await resolved.runtime.client.request<LspWorkspaceEdit>(
        'textDocument/rename',
        {
          textDocument: { uri: resolved.document.uri },
          position: { line: resolved.line - 1, character: resolved.column - 1 },
          newName: input.newName,
        }
      );
      const edit = normalizeWorkspaceEdit(response);

      if (input.apply === true) {
        // Apply the workspace edit directly
        for (const change of edit.changes) {
          let content = await readFile(change.filePath, 'utf-8');
          const sorted = [...change.edits].sort(
            (a, b) => b.range.start.line - a.range.start.line
          );
          for (const textEdit of sorted) {
            const lines = content.split('\n');
            const startLine = textEdit.range.start.line;
            const startChar = textEdit.range.start.character;
            const endLine = textEdit.range.end.line;
            const endChar = textEdit.range.end.character;

            if (startLine === endLine) {
              const line = lines[startLine];
              lines[startLine] =
                line.slice(0, startChar) +
                textEdit.newText +
                line.slice(endChar);
            } else {
              const before = lines[startLine].slice(0, startChar);
              const after = lines[endLine].slice(endChar);
              const replacement = textEdit.newText;
              lines.splice(
                startLine,
                endLine - startLine + 1,
                before + replacement + after
              );
            }
            content = lines.join('\n');
          }
          await writeFile(change.filePath, content, 'utf-8');
        }
        return JSON.stringify(
          {
            summary: describeWorkspaceEdit(edit),
            applied: true,
          },
          null,
          2
        );
      }

      const truncated = truncateWorkspaceEdit(edit, HEAVY_EDIT_BUDGET);
      return JSON.stringify(
        {
          query: {
            filePath: resolved.document.uri,
            line: resolved.line,
            column: resolved.column,
            newName: input.newName,
          },
          edit: truncated,
          summary: describeWorkspaceEdit(edit),
        },
        null,
        2
      );
    },
  };
}

export function createFormattingTool(
  server: ServerManager
): DroneToolDefinition {
  return {
    name: 'formatting',
    description:
      'Format a file using the LSP server. Applies formatting edits directly.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative or absolute file path.',
        },
        tabSize: {
          type: 'integer',
          description: 'Optional tab size hint forwarded to the server.',
        },
        insertSpaces: {
          type: 'boolean',
          description: 'Optional space-vs-tabs hint forwarded to the server.',
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
      await server.refreshIfNeeded();
      const filePath = server.resolveTargetFilePath(input.filePath);
      const runtime = server.findRuntimeForFile(filePath);
      if (!runtime) {
        throw new Error(
          `No connected LSP server is available for ${filePath}.`
        );
      }
      const document = await server.ensureDocumentLoaded(runtime, filePath);
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
      const response = await runtime.client.request<
        Array<{
          range?: {
            start?: { line?: number; character?: number };
            end?: { line?: number; character?: number };
          };
          newText?: string;
        }>
      >('textDocument/formatting', {
        textDocument: { uri: document.uri },
        options,
      });
      const edits = normalizeTextEdits(response);

      // Apply edits to the file
      let content = await readFile(filePath, 'utf-8');
      const sorted = [...edits].sort(
        (a, b) => b.range.start.line - a.range.start.line
      );
      for (const textEdit of sorted) {
        const lines = content.split('\n');
        const startLine = textEdit.range.start.line;
        const startChar = textEdit.range.start.character;
        const endLine = textEdit.range.end.line;
        const endChar = textEdit.range.end.character;

        if (startLine === endLine) {
          const line = lines[startLine];
          lines[startLine] =
            line.slice(0, startChar) + textEdit.newText + line.slice(endChar);
        } else {
          const before = lines[startLine].slice(0, startChar);
          const after = lines[endLine].slice(endChar);
          const replacement = textEdit.newText;
          lines.splice(
            startLine,
            endLine - startLine + 1,
            before + replacement + after
          );
        }
        content = lines.join('\n');
      }
      await writeFile(filePath, content, 'utf-8');

      return JSON.stringify(
        {
          summary: `Formatted ${filePath}`,
          applied: true,
        },
        null,
        2
      );
    },
  };
}

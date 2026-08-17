import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DroneToolDefinition } from 'drone-core';
import { AmbiguousPositionError } from 'drone-core';
import { createServerManager } from '../src/plugins/lsp/server.js';
import {
  createGoToTool,
  createFindReferencesTool,
} from '../src/plugins/lsp/tools/navigation.js';
import {
  createCodeActionTool,
  createRenameTool,
  createFormattingTool,
} from '../src/plugins/lsp/tools/editing.js';
import {
  createInspectTool,
  createCompletionTool,
} from '../src/plugins/lsp/tools/completion.js';
import { createCallHierarchyTool } from '../src/plugins/lsp/tools/hierarchy.js';
import { createGetDiagnosticsTool } from '../src/plugins/lsp/tools/diagnostics.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * Create a minimal ServerManager for testing text resolution.
 * No real LSP servers are connected — text resolution only reads files.
 */
async function createTestServerManager(workspaceRoot: string) {
  return createServerManager({
    workspaceRoot,
    lspConfig: {
      enabled: true,
      diagnosticTokenBudget: 500,
      requestTimeoutMs: 5000,
      preferExternal: false,
      autoInstall: false,
      servers: {},
    },
    logger: silentLogger(),
  });
}

/**
 * Create a temp file and return its path.
 */
async function createTempFile(
  dir: string,
  name: string,
  content: string
): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

function createMockServer() {
  return {
    refreshIfNeeded: async () => {},
    markDirty: () => {},
    getDiagnostics: () => [],
    getServerStates: () => [],
    renderDiagnosticsPrompt: () => false,
    findRuntimeForFile: () => undefined,
    ensureDocumentLoaded: async () => {
      throw new Error('not connected');
    },
    resolveTargetFilePath: (p: string) => p,
    parsePositionInput: async () => ({ filePath: '', line: 1, column: 1 }),
    resolveAtPosition: async () => {
      throw new Error('not connected');
    },
    readFileSnippet: async (_filePath: string, _line: number) => '',
    readLineFingerprint: async () => undefined,
    storeReferences: () => [],
    resolveReference: async () => undefined,
    locationToAgentShape: (_l: unknown[]) => [],
    initialize: async () => {},
    shutdown: async () => {},
    getAvailableServers: () => [],
    startServerForFile: async () => false,
  } as Parameters<typeof createInspectTool>[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveTextPosition (via parsePositionInput)', () => {
  it('finds exact text match and returns 1-based position', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          'function greet(name: string): string {',
          '  return `Hello, ${name}!`;',
          '}',
          '',
          'const result = greet("World");',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      const result = await server.parsePositionInput('lsp__test', {
        filePath,
        text: 'function greet',
      });

      expect(result.filePath).toBe(filePath);
      expect(result.line).toBe(1);
      expect(result.column).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('finds text in the middle of a line', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          'function greet(name: string): string {',
          '  return `Hello, ${name}!`;',
          '}',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      const result = await server.parsePositionInput('lsp__test', {
        filePath,
        text: 'Hello',
      });

      expect(result.line).toBe(2);
      expect(result.column).toBe(11);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to case-insensitive match when exact match fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        'function greet() {}'
      );
      const server = await createTestServerManager(dir);

      const result = await server.parsePositionInput('lsp__test', {
        filePath,
        text: 'FUNCTION GREET',
      });

      expect(result.line).toBe(1);
      expect(result.column).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws AmbiguousPositionError on ambiguous text with structured data', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          'const x = 1;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const x = 2;',
          'const z = 4;',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      const err = await server
        .parsePositionInput('lsp__test', {
          filePath,
          text: 'const x',
        })
        .catch(e => e);

      expect(err).toBeInstanceOf(AmbiguousPositionError);
      const ambErr = err as AmbiguousPositionError;
      expect(ambErr.matches).toHaveLength(2);
      expect(ambErr.matches[0]).toMatchObject({
        filePath,
        line: 1,
        column: 1,
      });
      expect(ambErr.matches[1]).toMatchObject({
        filePath,
        line: 11,
        column: 1,
      });
      expect(ambErr.matches[0].context).toContain('const x = 1');
      expect(ambErr.matches[1].context).toContain('const x = 2');
      expect(ambErr.matches[0].suggestedContext).toBeDefined();
      expect(ambErr.matches[1].suggestedContext).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when text is not found', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        'function greet() {}'
      );
      const server = await createTestServerManager(dir);

      const err = await server
        .parsePositionInput('lsp__test', {
          filePath,
          text: 'nonexistent_symbol_xyz',
        })
        .catch(e => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('not found');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still works with traditional line/column input', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        'function greet() {}'
      );
      const server = await createTestServerManager(dir);

      const result = await server.parsePositionInput('lsp__test', {
        filePath,
        line: 1,
        column: 10,
      });

      expect(result.filePath).toBe(filePath);
      expect(result.line).toBe(1);
      expect(result.column).toBe(10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('surroundingText disambiguation', () => {
  it('disambiguates multiple text matches with surroundingText', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          'class User {',
          '  id: number;',
          '  name: string;',
          '}',
          '',
          'const id = "different";',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      // Without surroundingText, "id" is ambiguous (appears on lines 2 and 6)
      const err = await server
        .parsePositionInput('lsp__test', {
          filePath,
          text: 'id',
        })
        .catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('ambiguous');

      // With surroundingText "class User {", it resolves to line 2
      const result = await server.parsePositionInput('lsp__test', {
        filePath,
        text: 'id',
        surroundingText: 'class User {',
      });

      expect(result.line).toBe(2);
      expect(result.column).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('disambiguates via surroundingText parameter (not input field)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          '// FIRST SECTION',
          'const x = 1;',
          '// END FIRST',
          '',
          '// SECOND SECTION',
          'const x = 2;',
          '// END SECOND',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      // Using surroundingText as a parameter
      const result = await server.parsePositionInput(
        'lsp__test',
        { filePath, text: 'const x' },
        '// SECOND SECTION'
      );

      expect(result.line).toBe(6);
      expect(result.column).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('disambiguates via surroundingText from input field', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          '// FIRST SECTION',
          'const x = 1;',
          '// END FIRST',
          '',
          '// SECOND SECTION',
          'const x = 2;',
          '// END SECOND',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      // Using surroundingText from input.surroundingText
      const result = await server.parsePositionInput('lsp__test', {
        filePath,
        text: 'const x',
        surroundingText: '// FIRST SECTION',
      });

      expect(result.line).toBe(2);
      expect(result.column).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('grows the filter window to match a multi-line handed-back block', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      // The unique marker line is 5+ lines away from the match, so a
      // single-line surroundingText would not find it — only a multi-line
      // block (which sizes the window to its line count) can disambiguate.
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          '// FIRST BLOCK',
          'const value = 1;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const value = 2;',
          '// SECOND BLOCK',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      // Hand back a dense, contiguous block that includes the unique marker
      // line ("// FIRST BLOCK") several lines away from the match.
      const block = [
        '// FIRST BLOCK',
        'const value = 1;',
        'const filler = 0;',
        'const filler = 0;',
        'const filler = 0;',
        'const filler = 0;',
        'const filler = 0;',
      ].join('\n');

      const result = await server.parsePositionInput('lsp__test', {
        filePath,
        text: 'const value',
        surroundingText: block,
      });

      expect(result.line).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses exact match (trim-only), not substring, for disambiguation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      // A commented variant of the target line appears in the second match's
      // window. Substring matching would wrongly disambiguate; exact match
      // must not.
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          '// FIRST BLOCK',
          'const value = 1;',
          '// END FIRST',
          '',
          '// SECOND BLOCK',
          '// const value = 1;',
          '// END SECOND',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      const result = await server.parsePositionInput('lsp__test', {
        filePath,
        text: 'const value',
        surroundingText: 'const value = 1;',
      });

      // The commented variant is not an exact line match, so only the real
      // line matches — exact match correctly disambiguates to line 2, where
      // substring matching would have matched both and stayed ambiguous.
      expect(result.line).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('suggestedContext', () => {
  it('suggests a unique dense block for each ambiguous match', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          '// FIRST BLOCK',
          'const value = 1;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const value = 2;',
          '// SECOND BLOCK',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      const err = await server
        .parsePositionInput('lsp__test', {
          filePath,
          text: 'const value',
        })
        .catch(e => e);

      expect(err).toBeInstanceOf(AmbiguousPositionError);
      const ambErr = err as AmbiguousPositionError;
      const match1 = ambErr.matches.find(m => m.line === 2);
      const match2 = ambErr.matches.find(m => m.line === 11);
      expect(match1).toBeDefined();
      expect(match2).toBeDefined();
      expect(match1!.suggestedContext).toContain('FIRST');
      expect(match2!.suggestedContext).toBeDefined();
      // The suggested block is dense and multi-line, centered on the match.
      expect(match1!.suggestedContext!.split('\n').length).toBeGreaterThan(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no unique context exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      // Matches so close together that every line appears in other windows
      // even at the 30-line hard limit.
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
          'const repeated = 0;',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      // Query "const repeated" for many matches
      const err = await server
        .parsePositionInput('lsp__test', {
          filePath,
          text: 'const repeated',
        })
        .catch(e2 => e2);
      expect(err).toBeInstanceOf(AmbiguousPositionError);
      const ambErr = err as AmbiguousPositionError;
      expect(ambErr.matches.length).toBeGreaterThan(1);
      // Every line is "const repeated = 0;" — no unique context exists.
      for (const m of ambErr.matches) {
        expect(m.suggestedContext).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('reference ID storage and retrieval', () => {
  it('stores and resolves reference IDs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const server = await createTestServerManager(dir);
      const filePath = await createTempFile(
        dir,
        'ref.ts',
        ['line one', 'line two', 'line three'].join('\n')
      );

      const ids = server.storeReferences([
        {
          filePath,
          line: 2,
          column: 5,
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 15 },
          },
          fingerprint: 'line two',
        },
        {
          filePath,
          line: 3,
          column: 8,
          range: {
            start: { line: 2, character: 7 },
            end: { line: 2, character: 18 },
          },
          fingerprint: 'line three',
        },
      ]);

      expect(ids).toHaveLength(2);
      expect(ids[0]).toMatch(/^ref_\d+$/);
      expect(ids[1]).toMatch(/^ref_\d+$/);

      const ref1 = await server.resolveReference(ids[0]);
      expect(ref1).toBeDefined();
      expect(ref1!.stale).toBe(false);
      expect(ref1!.location.filePath).toBe(filePath);
      expect(ref1!.location.line).toBe(2);
      expect(ref1!.location.column).toBe(5);

      const ref2 = await server.resolveReference(ids[1]);
      expect(ref2).toBeDefined();
      expect(ref2!.stale).toBe(false);
      expect(ref2!.location.filePath).toBe(filePath);
      expect(ref2!.location.line).toBe(3);
      expect(ref2!.location.column).toBe(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for unknown reference IDs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const server = await createTestServerManager(dir);
      const ref = await server.resolveReference('ref_999');
      expect(ref).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns stale when the file line changes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const server = await createTestServerManager(dir);
      const filePath = await createTempFile(
        dir,
        'stale.ts',
        ['line one', 'line two', 'line three'].join('\n')
      );

      const ids = server.storeReferences([
        {
          filePath,
          line: 2,
          column: 5,
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 15 },
          },
          fingerprint: 'line two',
        },
      ]);

      // Modify the file so the fingerprint no longer matches.
      await writeFile(filePath, 'line one\nCHANGED\nline three', 'utf-8');

      const ref = await server.resolveReference(ids[0]);
      expect(ref).toBeDefined();
      expect(ref!.stale).toBe(true);

      // The stale entry is removed from the cache.
      const again = await server.resolveReference(ids[0]);
      expect(again).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns stale when the file is deleted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const server = await createTestServerManager(dir);
      const filePath = await createTempFile(
        dir,
        'gone.ts',
        ['line one', 'line two'].join('\n')
      );

      const ids = server.storeReferences([
        {
          filePath,
          line: 2,
          column: 5,
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 15 },
          },
          fingerprint: 'line two',
        },
      ]);

      await rm(filePath);

      const ref = await server.resolveReference(ids[0]);
      expect(ref).toBeDefined();
      expect(ref!.stale).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const server = await createTestServerManager(dir);
      const filePath = await createTempFile(
        dir,
        'ttl.ts',
        ['line one', 'line two'].join('\n')
      );

      const ids = server.storeReferences([
        {
          filePath,
          line: 2,
          column: 5,
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 15 },
          },
          fingerprint: 'line two',
        },
      ]);

      // Before TTL, resolves fine.
      const before = await server.resolveReference(ids[0]);
      expect(before).toBeDefined();
      expect(before!.stale).toBe(false);

      // Advance past the 10-minute TTL.
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);

      const after = await server.resolveReference(ids[0]);
      expect(after).toBeUndefined();
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('evicts the oldest entry when the cache exceeds the cap', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const server = await createTestServerManager(dir);
      const filePath = await createTempFile(
        dir,
        'cap.ts',
        ['line one', 'line two'].join('\n')
      );

      // Insert 101 references (cap is 100). The first should be evicted.
      const ids = server.storeReferences(
        Array.from({ length: 101 }, () => ({
          filePath,
          line: 2,
          column: 5,
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 15 },
          },
          fingerprint: 'line two',
        }))
      );

      expect(ids).toHaveLength(101);
      const first = await server.resolveReference(ids[0]);
      expect(first).toBeUndefined();
      const last = await server.resolveReference(ids[100]);
      expect(last).toBeDefined();
      expect(last!.stale).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readFileSnippet', () => {
  it('returns code snippet around a position', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          'line 1',
          'line 2',
          'line 3',
          'line 4',
          'line 5',
          'line 6',
          'line 7',
          'line 8',
          'line 9',
          'line 10',
          'line 11',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);

      const snippet = await server.readFileSnippet(filePath, 5, 2);
      expect(snippet).toContain('line 3');
      expect(snippet).toContain('line 5');
      expect(snippet).toContain('line 7');
      expect(snippet).toContain('>');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns empty string for non-existent file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const server = await createTestServerManager(dir);
      const result = await server.readFileSnippet('/nonexistent/file.ts', 1);
      expect(result).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('rename/code_action ambiguity returns reference IDs', () => {
  it('rename returns reference IDs when text is ambiguous', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          '// FIRST BLOCK',
          'const value = 1;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const value = 2;',
          '// SECOND BLOCK',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);
      const tool = createRenameTool(server);

      const result = await tool.execute({
        filePath,
        text: 'const value',
        newName: 'renamed',
      });

      const parsed = JSON.parse(result as string);
      expect(parsed.ambiguous).toBe(true);
      expect(parsed.matches).toHaveLength(2);
      expect(parsed.matches[0].referenceId).toMatch(/^ref_\d+$/);
      expect(parsed.matches[0].suggestedContext).toContain('FIRST');
      expect(parsed.matches[1].suggestedContext).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('code_action with a referenceId targets ref.filePath, not the input filePath', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const inputFilePath = await createTempFile(
        dir,
        'input.ts',
        ['const x = 1;'].join('\n')
      );
      const refFilePath = await createTempFile(
        dir,
        'ref.ts',
        ['const y = 2;'].join('\n')
      );

      const loadedFiles: string[] = [];
      const runtime = {
        client: {
          request: async () => [],
        },
      };
      const server = {
        refreshIfNeeded: async () => {},
        markDirty: () => {},
        getDiagnostics: () => [],
        getServerStates: () => [],
        renderDiagnosticsPrompt: () => false,
        findRuntimeForFile: () => runtime,
        ensureDocumentLoaded: async (_r: unknown, filePath: string) => {
          loadedFiles.push(filePath);
          return {
            uri: `file://${filePath}`,
            languageId: 'typescript',
            version: 1,
            text: '',
            mtimeMs: 0,
            size: 0,
          };
        },
        resolveTargetFilePath: (p: string) => p,
        parsePositionInput: async () => ({ filePath: '', line: 1, column: 1 }),
        resolveAtPosition: async () => {
          throw new Error('not connected');
        },
        readFileSnippet: async () => '',
        readLineFingerprint: async () => undefined,
        storeReferences: () => [],
        resolveReference: async () => ({
          location: {
            filePath: refFilePath,
            line: 1,
            column: 1,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            fingerprint: 'const y = 2;',
          },
          stale: false,
        }),
        locationToAgentShape: (_l: unknown[]) => [],
        initialize: async () => {},
        shutdown: async () => {},
        getAvailableServers: () => [],
        startServerForFile: async () => false,
      } as unknown as Parameters<typeof createCodeActionTool>[0];

      const tool = createCodeActionTool(server);
      await tool.execute({
        filePath: inputFilePath,
        referenceId: 'ref_1',
      });

      // The tool must target the reference's file, not the input file.
      expect(loadedFiles).toContain(refFilePath);
      expect(loadedFiles).not.toContain(inputFilePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('code_action returns reference IDs when text is ambiguous', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          '// FIRST BLOCK',
          'const value = 1;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const filler = 0;',
          'const value = 2;',
          '// SECOND BLOCK',
        ].join('\n')
      );
      const server = await createTestServerManager(dir);
      const tool = createCodeActionTool(server);

      const result = await tool.execute({
        filePath,
        text: 'const value',
      });

      const parsed = JSON.parse(result as string);
      expect(parsed.ambiguous).toBe(true);
      expect(parsed.matches).toHaveLength(2);
      expect(parsed.matches[0].referenceId).toMatch(/^ref_\d+$/);
      expect(parsed.matches[0].suggestedContext).toContain('FIRST');
      expect(parsed.matches[1].suggestedContext).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('tool input schemas accept text/symbol parameters', () => {
  function expectTextSymbolParams(tool: DroneToolDefinition, _name: string) {
    const schema = tool.inputSchema;
    expect(schema).toBeDefined();
    const props = schema!.properties ?? {};
    expect(props.text).toBeDefined();
    expect(props.symbol).toBeDefined();
    expect(props.line).toBeDefined();
    expect(props.column).toBeDefined();
    expect(schema!.required).not.toContain('line');
    expect(schema!.required).not.toContain('column');
  }

  const server = createMockServer();

  it('inspect accepts text/symbol', () => {
    const tool = createInspectTool(server);
    expectTextSymbolParams(tool, 'inspect');
  });

  it('go_to accepts text/symbol', () => {
    const tool = createGoToTool(server);
    expectTextSymbolParams(tool, 'go_to');
  });

  it('find_references accepts text/symbol', () => {
    const tool = createFindReferencesTool(server);
    expectTextSymbolParams(tool, 'find_references');
  });

  it('completion accepts text/symbol', () => {
    const tool = createCompletionTool(server);
    expectTextSymbolParams(tool, 'completion');
  });

  it('call_hierarchy accepts text/symbol', () => {
    const tool = createCallHierarchyTool(server);
    expectTextSymbolParams(tool, 'call_hierarchy');
  });

  it('rename accepts text/symbol, apply, and referenceId', () => {
    const tool = createRenameTool(server);
    const schema = tool.inputSchema!;
    const props = schema.properties ?? {};
    expect(props.text).toBeDefined();
    expect(props.symbol).toBeDefined();
    expect(props.apply).toBeDefined();
    expect((props.apply as { type: string }).type).toBe('boolean');
    expect(props.referenceId).toBeDefined();
    expect(schema.required).not.toContain('line');
    expect(schema.required).not.toContain('column');
    expect(schema.required).toContain('newName');
  });

  it('code_action accepts text/symbol, optional range, and referenceId', () => {
    const tool = createCodeActionTool(server);
    const schema = tool.inputSchema!;
    const props = schema.properties ?? {};
    expect(props.text).toBeDefined();
    expect(props.symbol).toBeDefined();
    expect(props.referenceId).toBeDefined();
    expect(schema.required).not.toContain('startLine');
    expect(schema.required).not.toContain('startColumn');
    expect(schema.required).not.toContain('endLine');
    expect(schema.required).not.toContain('endColumn');
  });

  it('get_diagnostics is file/severity-only (no text/symbol)', () => {
    const tool = createGetDiagnosticsTool(server);
    const props = tool.inputSchema!.properties ?? {};
    expect(props.text).toBeUndefined();
    expect(props.symbol).toBeUndefined();
    expect(props.surroundingText).toBeUndefined();
  });

  it('formatting does not have text/symbol (file-level tool)', () => {
    const tool = createFormattingTool(server);
    const props = tool.inputSchema!.properties ?? {};
    expect(props.text).toBeUndefined();
    expect(props.symbol).toBeUndefined();
  });
});

describe('tool descriptions mention new features', () => {
  it('go_to mentions auto-expansion', () => {
    const tool = createGoToTool(createMockServer());
    expect(tool.description.toLowerCase()).toContain('snippet');
  });

  it('find_references mentions auto-expansion', () => {
    const tool = createFindReferencesTool(createMockServer());
    expect(tool.description.toLowerCase()).toContain('snippet');
  });

  it('inspect mentions snippet', () => {
    const tool = createInspectTool(createMockServer());
    expect(tool.description.toLowerCase()).toContain('snippet');
  });

  it('completion mentions snippet', () => {
    const tool = createCompletionTool(createMockServer());
    expect(tool.description.toLowerCase()).toContain('snippet');
  });

  it('rename mentions referenceId', () => {
    const tool = createRenameTool(createMockServer());
    expect(tool.description.toLowerCase()).toContain('referenceid');
  });

  it('code_action mentions referenceId', () => {
    const tool = createCodeActionTool(createMockServer());
    expect(tool.description.toLowerCase()).toContain('referenceid');
  });
});

describe('rename tool description mentions apply', () => {
  it('rename description mentions apply parameter', () => {
    const tool = createRenameTool(createMockServer());
    expect(tool.description.toLowerCase()).toContain('apply');
  });
});

describe('formatting tool description mentions auto-apply', () => {
  it('formatting description mentions applying edits', () => {
    const tool = createFormattingTool(createMockServer());
    expect(tool.description.toLowerCase()).toContain('applies');
  });
});

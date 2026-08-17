import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DroneToolDefinition } from 'drone-core';
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

  it('throws on ambiguous text with context in error message', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const filePath = await createTempFile(
        dir,
        'test.ts',
        [
          'const x = 1;',
          'const y = 2;',
          'const x = 3; // duplicate',
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

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('ambiguous');
      expect(err.message).toContain('2 matches');
      expect(err.message).toContain('Line 1');
      expect(err.message).toContain('Line 3');
      expect(err.message).toContain('const x = 1');
      expect(err.message).toContain('const x = 3');
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

      // With surroundingText "class User", it resolves to line 2
      const result = await server.parsePositionInput('lsp__test', {
        filePath,
        text: 'id',
        surroundingText: 'class User',
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
        ['// FIRST SECTION', 'const x = 1;', '// END FIRST', '', '// SECOND SECTION', 'const x = 2;', '// END SECOND'].join('\n')
      );
      const server = await createTestServerManager(dir);

      // Using surroundingText as a parameter
      const result = await server.parsePositionInput(
        'lsp__test',
        { filePath, text: 'const x' },
        'SECOND SECTION'
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
        ['// FIRST SECTION', 'const x = 1;', '// END FIRST', '', '// SECOND SECTION', 'const x = 2;', '// END SECOND'].join('\n')
      );
      const server = await createTestServerManager(dir);

      // Using surroundingText from input.surroundingText
      const result = await server.parsePositionInput('lsp__test', {
        filePath,
        text: 'const x',
        surroundingText: 'FIRST SECTION',
      });

      expect(result.line).toBe(2);
      expect(result.column).toBe(1);
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

      const ids = server.storeReferences([
        {
          filePath: '/foo/bar.ts',
          line: 10,
          column: 5,
          range: {
            start: { line: 9, character: 4 },
            end: { line: 9, character: 15 },
          },
        },
        {
          filePath: '/baz/qux.ts',
          line: 20,
          column: 8,
          range: {
            start: { line: 19, character: 7 },
            end: { line: 19, character: 18 },
          },
        },
      ]);

      expect(ids).toHaveLength(2);
      expect(ids[0]).toMatch(/^ref_\d+$/);
      expect(ids[1]).toMatch(/^ref_\d+$/);

      const ref1 = server.resolveReference(ids[0]);
      expect(ref1).toBeDefined();
      expect(ref1!.filePath).toBe('/foo/bar.ts');
      expect(ref1!.line).toBe(10);
      expect(ref1!.column).toBe(5);

      const ref2 = server.resolveReference(ids[1]);
      expect(ref2).toBeDefined();
      expect(ref2!.filePath).toBe('/baz/qux.ts');
      expect(ref2!.line).toBe(20);
      expect(ref2!.column).toBe(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for unknown reference IDs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lsp-test-'));
    try {
      const server = await createTestServerManager(dir);
      const ref = server.resolveReference('ref_999');
      expect(ref).toBeUndefined();
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

      const snippet = await server.readFileSnippet(filePath, 5, 1, 2);
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
      // Use a path that doesn't exist and won't throw — the method returns ''
      const result = await server.readFileSnippet(
        '/nonexistent/file.ts',
        1,
        1
      );
      expect(result).toBe('');
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
      readFileSnippet: async () => '',
      storeReferences: () => [],
      resolveReference: () => undefined,
      locationToAgentShape: (_l: unknown[]) => [],
      initialize: async () => {},
      shutdown: async () => {},
      getAvailableServers: () => [],
      startServerForFile: async () => false,
    } as Parameters<typeof createInspectTool>[0];
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

  it('get_diagnostics accepts text/symbol and surroundingText', () => {
    const tool = createGetDiagnosticsTool(server);
    const props = tool.inputSchema!.properties ?? {};
    expect(props.text).toBeDefined();
    expect(props.symbol).toBeDefined();
    expect(props.surroundingText).toBeDefined();
  });

  it('formatting does not have text/symbol (file-level tool)', () => {
    const tool = createFormattingTool(server);
    const props = tool.inputSchema!.properties ?? {};
    expect(props.text).toBeUndefined();
    expect(props.symbol).toBeUndefined();
  });
});

describe('tool descriptions mention new features', () => {
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
      readFileSnippet: async () => '',
      storeReferences: () => [],
      resolveReference: () => undefined,
      locationToAgentShape: (_l: unknown[]) => [],
      initialize: async () => {},
      shutdown: async () => {},
      getAvailableServers: () => [],
      startServerForFile: async () => false,
    } as Parameters<typeof createRenameTool>[0];
  }

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
    const server = {
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
      readFileSnippet: async () => '',
      storeReferences: () => [],
      resolveReference: () => undefined,
      locationToAgentShape: (_l: unknown[]) => [],
      initialize: async () => {},
      shutdown: async () => {},
      getAvailableServers: () => [],
      startServerForFile: async () => false,
    } as Parameters<typeof createRenameTool>[0];

    const tool = createRenameTool(server);
    expect(tool.description.toLowerCase()).toContain('apply');
  });
});

describe('formatting tool description mentions auto-apply', () => {
  it('formatting description mentions applying edits', () => {
    const server = {
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
      readFileSnippet: async () => '',
      storeReferences: () => [],
      resolveReference: () => undefined,
      locationToAgentShape: (_l: unknown[]) => [],
      initialize: async () => {},
      shutdown: async () => {},
      getAvailableServers: () => [],
      startServerForFile: async () => false,
    } as Parameters<typeof createFormattingTool>[0];

    const tool = createFormattingTool(server);
    expect(tool.description.toLowerCase()).toContain('applies');
  });
});
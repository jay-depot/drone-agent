import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServerManager } from '../src/plugins/lsp/server.js';
import {
  createHoverTool,
  createGoToDefinitionTool,
  createFindReferencesTool,
  createImplementationTool,
  createTypeDefinitionTool,
} from '../src/plugins/lsp/tools/navigation.js';
import {
  createCodeActionTool,
  createRenameTool,
  createFormattingTool,
} from '../src/plugins/lsp/tools/editing.js';
import {
  createSignatureHelpTool,
  createCompletionTool,
} from '../src/plugins/lsp/tools/completion.js';
import {
  createCallHierarchyIncomingTool,
  createCallHierarchyOutgoingTool,
} from '../src/plugins/lsp/tools/hierarchy.js';
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
      // "  return `Hello" — column 11 is where 'H' starts (1-based)
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
      // Should include context lines around each match
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

describe('tool input schemas accept text/symbol parameters', () => {
  // Helper to check a tool's input schema has text/symbol params
  function expectTextSymbolParams(
    tool: {
      inputSchema: {
        properties?: Record<string, unknown>;
        required?: string[];
      };
    },
    _name: string
  ) {
    const props = tool.inputSchema.properties ?? {};
    expect(props.text).toBeDefined();
    expect(props.symbol).toBeDefined();
    expect(props.line).toBeDefined();
    expect(props.column).toBeDefined();
    // line/column should NOT be in required
    expect(tool.inputSchema.required).not.toContain('line');
    expect(tool.inputSchema.required).not.toContain('column');
  }

  // Create a minimal server for tool creation
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
      locationToAgentShape: (_l: unknown[]) => [],
      initialize: async () => {},
      shutdown: async () => {},
    } as Parameters<typeof createHoverTool>[0];
  }

  const server = createMockServer();

  it('hover accepts text/symbol', () => {
    const tool = createHoverTool(server);
    expectTextSymbolParams(tool, 'hover');
  });

  it('go_to_definition accepts text/symbol', () => {
    const tool = createGoToDefinitionTool(server);
    expectTextSymbolParams(tool, 'go_to_definition');
  });

  it('find_references accepts text/symbol', () => {
    const tool = createFindReferencesTool(server);
    expectTextSymbolParams(tool, 'find_references');
  });

  it('implementation accepts text/symbol', () => {
    const tool = createImplementationTool(server);
    expectTextSymbolParams(tool, 'implementation');
  });

  it('type_definition accepts text/symbol', () => {
    const tool = createTypeDefinitionTool(server);
    expectTextSymbolParams(tool, 'type_definition');
  });

  it('signature_help accepts text/symbol', () => {
    const tool = createSignatureHelpTool(server);
    expectTextSymbolParams(tool, 'signature_help');
  });

  it('completion accepts text/symbol', () => {
    const tool = createCompletionTool(server);
    expectTextSymbolParams(tool, 'completion');
  });

  it('call_hierarchy_incoming accepts text/symbol', () => {
    const tool = createCallHierarchyIncomingTool(server);
    expectTextSymbolParams(tool, 'call_hierarchy_incoming');
  });

  it('call_hierarchy_outgoing accepts text/symbol', () => {
    const tool = createCallHierarchyOutgoingTool(server);
    expectTextSymbolParams(tool, 'call_hierarchy_outgoing');
  });

  it('rename accepts text/symbol and apply', () => {
    const tool = createRenameTool(server);
    const props = tool.inputSchema.properties ?? {};
    expect(props.text).toBeDefined();
    expect(props.symbol).toBeDefined();
    expect(props.apply).toBeDefined();
    expect((props.apply as { type: string }).type).toBe('boolean');
    expect(tool.inputSchema.required).not.toContain('line');
    expect(tool.inputSchema.required).not.toContain('column');
    expect(tool.inputSchema.required).toContain('newName');
  });

  it('code_action accepts text/symbol and optional range', () => {
    const tool = createCodeActionTool(server);
    const props = tool.inputSchema.properties ?? {};
    expect(props.text).toBeDefined();
    expect(props.symbol).toBeDefined();
    // Range params should be optional
    expect(tool.inputSchema.required).not.toContain('startLine');
    expect(tool.inputSchema.required).not.toContain('startColumn');
    expect(tool.inputSchema.required).not.toContain('endLine');
    expect(tool.inputSchema.required).not.toContain('endColumn');
  });

  it('get_diagnostics accepts text/symbol', () => {
    const tool = createGetDiagnosticsTool(server);
    const props = tool.inputSchema.properties ?? {};
    expect(props.text).toBeDefined();
    expect(props.symbol).toBeDefined();
  });

  it('formatting does not have text/symbol (file-level tool)', () => {
    const tool = createFormattingTool(server);
    const props = tool.inputSchema.properties ?? {};
    expect(props.text).toBeUndefined();
    expect(props.symbol).toBeUndefined();
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
      locationToAgentShape: (_l: unknown[]) => [],
      initialize: async () => {},
      shutdown: async () => {},
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
      locationToAgentShape: (_l: unknown[]) => [],
      initialize: async () => {},
      shutdown: async () => {},
    } as Parameters<typeof createFormattingTool>[0];

    const tool = createFormattingTool(server);
    expect(tool.description.toLowerCase()).toContain('applies');
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  applyAgentConfigLayer,
  createConsoleLogger,
  createDefaultAgentConfig,
  getCanonicalToolName,
  type DroneAgentConfig,
  type PartialDroneAgentConfig,
} from '../src/index.js';

describe('createConsoleLogger', () => {
  it('prefixes messages with the scope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const logger = createConsoleLogger('scope-x');
      logger.info('hello');
      logger.warn('careful');
      logger.error('boom');

      expect(log).toHaveBeenCalledWith('[scope-x] hello');
      expect(warn).toHaveBeenCalledWith('[scope-x] careful');
      expect(error).toHaveBeenCalledWith('[scope-x] boom');
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe('getCanonicalToolName', () => {
  it('joins plugin id and tool name with a dot', () => {
    expect(getCanonicalToolName('file', 'read')).toBe('file.read');
    expect(getCanonicalToolName('mcp', 'github.list_prs')).toBe(
      'mcp.github.list_prs'
    );
  });
});

describe('createDefaultAgentConfig', () => {
  it('returns a complete config with sensible defaults', () => {
    const config = createDefaultAgentConfig();
    expect(config.enabledPlugins).toEqual([]);
    expect(config.activePersona).toBeNull();
    expect(config.ollama.host).toMatch(/^https?:\/\//);
    expect(config.ollama.model).toBeTruthy();
    expect(config.session.contextWindowTokens).toBeGreaterThan(0);
    expect(config.session.responseReserveTokens).toBeGreaterThan(0);
    expect(config.lsp.servers).toEqual({});
    expect(config.mcp.servers).toEqual({});
    expect(config.compaction.strategy).toBe('summary-drop');
  });

  it('returns a fresh object each call', () => {
    const a = createDefaultAgentConfig();
    const b = createDefaultAgentConfig();
    expect(a).not.toBe(b);
    expect(a.lsp.servers).not.toBe(b.lsp.servers);
    a.enabledPlugins.push('mutate-me');
    expect(b.enabledPlugins).toEqual([]);
  });
});

describe('applyAgentConfigLayer', () => {
  const base: DroneAgentConfig = createDefaultAgentConfig();

  it('returns the base config when the layer is empty', () => {
    const merged = applyAgentConfigLayer(base, {});
    expect(merged).toEqual(base);
  });

  it('replaces scalar fields when present in the layer', () => {
    const layer: PartialDroneAgentConfig = {
      enabledPlugins: ['file', 'search'],
      systemPrompt: 'Custom prompt',
      activePersona: 'reviewer',
    };
    const merged = applyAgentConfigLayer(base, layer);
    expect(merged.enabledPlugins).toEqual(['file', 'search']);
    expect(merged.systemPrompt).toBe('Custom prompt');
    expect(merged.activePersona).toBe('reviewer');
  });

  it('allows activePersona to be explicitly cleared with null', () => {
    const withPersona = applyAgentConfigLayer(base, { activePersona: 'p' });
    const cleared = applyAgentConfigLayer(withPersona, { activePersona: null });
    expect(cleared.activePersona).toBeNull();
  });

  it('deep-merges nested ollama / session / compaction sections', () => {
    const merged = applyAgentConfigLayer(base, {
      ollama: { model: 'qwen3:8b' },
      session: { contextWindowTokens: 65536 },
      compaction: { softThresholdPercent: 50 },
    });
    expect(merged.ollama).toEqual({ ...base.ollama, model: 'qwen3:8b' });
    expect(merged.session).toEqual({
      ...base.session,
      contextWindowTokens: 65536,
    });
    expect(merged.compaction.softThresholdPercent).toBe(50);
    expect(merged.compaction.enabled).toBe(base.compaction.enabled);
  });

  it('replaces LSP server map but merges LSP scalar fields', () => {
    const layer: PartialDroneAgentConfig = {
      lsp: {
        enabled: false,
        servers: {
          ts: {
            transport: 'stdio',
            command: 'typescript-language-server',
            args: ['--stdio'],
          },
        },
      },
    };
    const merged = applyAgentConfigLayer(base, layer);
    expect(merged.lsp.enabled).toBe(false);
    expect(Object.keys(merged.lsp.servers)).toEqual(['ts']);
  });

  it('replaces MCP server map but merges MCP scalar fields', () => {
    const layer: PartialDroneAgentConfig = {
      mcp: {
        retryCount: 5,
        servers: {
          remote: {
            transport: 'streamable_http',
            url: 'https://example.com/mcp',
          },
        },
      },
    };
    const merged = applyAgentConfigLayer(base, layer);
    expect(merged.mcp.retryCount).toBe(5);
    expect(Object.keys(merged.mcp.servers)).toEqual(['remote']);
    expect(merged.mcp.compatibilityMode).toBe(base.mcp.compatibilityMode);
  });

  it('keeps the base server map when the layer omits servers', () => {
    const populated = applyAgentConfigLayer(base, {
      lsp: { servers: { x: { transport: 'stdio', command: 'x' } } },
    });
    const merged = applyAgentConfigLayer(populated, {
      lsp: { enabled: false },
    });
    expect(Object.keys(merged.lsp.servers)).toEqual(['x']);
  });
});

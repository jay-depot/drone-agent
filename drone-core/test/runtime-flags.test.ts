import { describe, expect, it } from 'vitest';
import { createRuntimeFlagRegistry } from '../src/runtime-flags.js';

describe('RuntimeFlagRegistry', () => {
  describe('set and get', () => {
    it('sets and gets a flag value', () => {
      const reg = createRuntimeFlagRegistry();
      reg.set('debug', 'llm');
      expect(reg.get('debug')).toBe('llm');
    });

    it('overwrites previous value on set', () => {
      const reg = createRuntimeFlagRegistry();
      reg.set('debug', 'llm');
      reg.set('debug', 'mcp');
      expect(reg.get('debug')).toBe('mcp');
    });

    it('returns undefined for unset key', () => {
      const reg = createRuntimeFlagRegistry();
      expect(reg.get('missing')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('returns true for set flag', () => {
      const reg = createRuntimeFlagRegistry();
      reg.set('debug', 'llm');
      expect(reg.has('debug')).toBe(true);
    });

    it('returns false for unset flag', () => {
      const reg = createRuntimeFlagRegistry();
      expect(reg.has('debug')).toBe(false);
    });
  });

  describe('append', () => {
    it('creates a new flag when key does not exist', () => {
      const reg = createRuntimeFlagRegistry();
      reg.append('list-mount', 'file');
      expect(reg.get('list-mount')).toBe('file');
    });

    it('appends to an existing flag with comma separator', () => {
      const reg = createRuntimeFlagRegistry();
      reg.append('list-mount', 'file');
      reg.append('list-mount', 'lsp');
      expect(reg.get('list-mount')).toBe('file, lsp');
    });

    it('deduplicates values', () => {
      const reg = createRuntimeFlagRegistry();
      reg.append('list-mount', 'file');
      reg.append('list-mount', 'lsp');
      reg.append('list-mount', 'file'); // duplicate
      expect(reg.get('list-mount')).toBe('file, lsp');
    });

    it('handles multiple appends', () => {
      const reg = createRuntimeFlagRegistry();
      reg.append('list-mount', 'file');
      reg.append('list-mount', 'lsp');
      reg.append('list-mount', 'git');
      reg.append('list-mount', 'mcp');
      reg.append('list-mount', 'swarm');
      expect(reg.get('list-mount')).toBe('file, lsp, git, mcp, swarm');
    });
  });

  describe('entries', () => {
    it('returns a Map of all flags', () => {
      const reg = createRuntimeFlagRegistry();
      reg.set('debug', 'llm');
      reg.append('list-mount', 'file');
      const entries = reg.entries();
      expect(entries.size).toBe(2);
      expect(entries.get('debug')).toBe('llm');
      expect(entries.get('list-mount')).toBe('file');
    });

    it('returns a copy, not the internal map', () => {
      const reg = createRuntimeFlagRegistry();
      reg.set('debug', 'llm');
      const entries = reg.entries();
      entries.set('debug', 'modified');
      expect(reg.get('debug')).toBe('llm');
    });
  });

  describe('render', () => {
    it('returns null when no flags are set', () => {
      const reg = createRuntimeFlagRegistry();
      expect(reg.render()).toBeNull();
    });

    it('renders list-mount flag with explainer and active plugins', () => {
      const reg = createRuntimeFlagRegistry();
      reg.append('list-mount', 'file');
      reg.append('list-mount', 'lsp');
      const result = reg.render();
      expect(result).not.toBeNull();
      expect(result).toContain('# Runtime Flags');
      expect(result).toContain('## List/Mount Pattern');
      expect(result).toContain('`<plugin>__list_tools`');
      expect(result).toContain('`<plugin>__mount_tool`');
      expect(result).toContain('`<plugin>__unmount_tool`');
      expect(result).toContain('Active list-mount plugins: file, lsp');
    });

    it('renders non-list-mount flags as key: value lines', () => {
      const reg = createRuntimeFlagRegistry();
      reg.set('debug', 'llm, mcp');
      const result = reg.render();
      expect(result).not.toBeNull();
      expect(result).toContain('# Runtime Flags');
      expect(result).toContain('debug: llm, mcp');
      expect(result).not.toContain('## List/Mount Pattern');
    });

    it('renders both list-mount and other flags together', () => {
      const reg = createRuntimeFlagRegistry();
      reg.append('list-mount', 'file');
      reg.append('list-mount', 'git');
      reg.set('debug', 'llm');
      const result = reg.render();
      expect(result).not.toBeNull();
      expect(result).toContain('# Runtime Flags');
      expect(result).toContain('## List/Mount Pattern');
      expect(result).toContain('Active list-mount plugins: file, git');
      expect(result).toContain('debug: llm');
    });
  });
});

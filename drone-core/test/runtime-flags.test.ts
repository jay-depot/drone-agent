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
      reg.append('plugins', 'file');
      expect(reg.get('plugins')).toBe('file');
    });

    it('appends to an existing flag with comma separator', () => {
      const reg = createRuntimeFlagRegistry();
      reg.append('plugins', 'file');
      reg.append('plugins', 'lsp');
      expect(reg.get('plugins')).toBe('file, lsp');
    });

    it('deduplicates values', () => {
      const reg = createRuntimeFlagRegistry();
      reg.append('plugins', 'file');
      reg.append('plugins', 'lsp');
      reg.append('plugins', 'file'); // duplicate
      expect(reg.get('plugins')).toBe('file, lsp');
    });
  });

  describe('entries', () => {
    it('returns a Map of all flags', () => {
      const reg = createRuntimeFlagRegistry();
      reg.set('debug', 'llm');
      reg.set('plugins', 'file, git');
      const entries = reg.entries();
      expect(entries.size).toBe(2);
      expect(entries.get('debug')).toBe('llm');
      expect(entries.get('plugins')).toBe('file, git');
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

    it('renders tool management explainer and flags', () => {
      const reg = createRuntimeFlagRegistry();
      reg.set('plugins', 'exec, file, git');
      const result = reg.render();
      expect(result).not.toBeNull();
      expect(result).toContain('# Runtime Flags');
      expect(result).toContain('## Tool Management');
      expect(result).toContain('`runtime__list_tools`');
      expect(result).toContain('`runtime__mount_tool`');
      expect(result).toContain('`runtime__unmount_tool`');
      expect(result).toContain('plugins: exec, file, git');
    });

    it('renders multiple flags as key: value lines', () => {
      const reg = createRuntimeFlagRegistry();
      reg.set('debug', 'llm, mcp');
      reg.set('plugins', 'exec, file');
      const result = reg.render();
      expect(result).not.toBeNull();
      expect(result).toContain('# Runtime Flags');
      expect(result).toContain('## Tool Management');
      expect(result).toContain('debug: llm, mcp');
      expect(result).toContain('plugins: exec, file');
    });
  });
});

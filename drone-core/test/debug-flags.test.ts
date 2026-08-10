import { describe, expect, it } from 'vitest';
import { createDebugFlagRegistry } from '../src/debug-flags.js';

describe('createDebugFlagRegistry', () => {
  it('starts with no subsystems enabled by default', () => {
    const reg = createDebugFlagRegistry();
    expect(reg.isEnabled('llm')).toBe(false);
    expect(reg.list()).toEqual([]);
  });

  it('seeds from an initial list', () => {
    const reg = createDebugFlagRegistry(['llm', 'tools']);
    expect(reg.isEnabled('llm')).toBe(true);
    expect(reg.isEnabled('tools')).toBe(true);
    expect(reg.isEnabled('mcp')).toBe(false);
    expect(reg.list()).toEqual(['llm', 'tools']);
  });

  it('enable makes a subsystem enabled (idempotent)', () => {
    const reg = createDebugFlagRegistry();
    reg.enable('llm');
    expect(reg.isEnabled('llm')).toBe(true);
    reg.enable('llm');
    expect(reg.isEnabled('llm')).toBe(true);
    expect(reg.list()).toEqual(['llm']);
  });

  it('disable makes a subsystem disabled (idempotent)', () => {
    const reg = createDebugFlagRegistry(['llm', 'tools']);
    reg.disable('llm');
    expect(reg.isEnabled('llm')).toBe(false);
    expect(reg.isEnabled('tools')).toBe(true);
    reg.disable('llm');
    expect(reg.isEnabled('llm')).toBe(false);
    expect(reg.list()).toEqual(['tools']);
  });

  it('disable on a never-enabled subsystem is a no-op', () => {
    const reg = createDebugFlagRegistry();
    reg.disable('mcp');
    expect(reg.isEnabled('mcp')).toBe(false);
    expect(reg.list()).toEqual([]);
  });

  it('list reflects the current enabled set in insertion order', () => {
    const reg = createDebugFlagRegistry();
    reg.enable('tools');
    reg.enable('llm');
    reg.disable('tools');
    expect(reg.list()).toEqual(['llm']);
  });
});

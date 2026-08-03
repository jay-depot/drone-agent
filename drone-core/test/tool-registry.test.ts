import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tool-registry.js';
import type { DroneToolDefinition } from '../src/plugin-system.js';

function makeTool(
  name: string,
  description = 'A test tool'
): DroneToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', additionalProperties: false },
    execute: async () => 'ok',
  };
}

describe('ToolRegistry', () => {
  it('add stores a tool unmounted', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read', 'Read a file'));
    expect(reg.getTotalCount()).toBe(1);
    expect(reg.getMountedCount()).toBe(0);
    expect(reg.isMounted('file__read')).toBe(false);
  });

  it('remove deletes a tool', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read'));
    reg.remove('file__read');
    expect(reg.getTotalCount()).toBe(0);
    expect(reg.get('file__read')).toBeUndefined();
  });

  it('remove is a no-op for a non-existent tool', () => {
    const reg = new ToolRegistry();
    expect(() => reg.remove('nonexistent')).not.toThrow();
  });

  it('mount makes a tool visible and returns its definition', () => {
    const reg = new ToolRegistry();
    const tool = makeTool('read', 'Read a file');
    reg.add('file__read', tool);
    const result = reg.mount('file__read');
    expect(result).toBe(tool);
    expect(reg.isMounted('file__read')).toBe(true);
    expect(reg.getMountedCount()).toBe(1);
  });

  it('mount returns undefined for a non-existent tool', () => {
    const reg = new ToolRegistry();
    expect(reg.mount('nonexistent')).toBeUndefined();
  });

  it('mount is idempotent (does not re-mount if already mounted)', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read'));
    reg.mount('file__read');
    const result = reg.mount('file__read');
    expect(result).toBeUndefined();
    expect(reg.getMountedCount()).toBe(1);
  });

  it('unmount hides a tool', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read'));
    reg.mount('file__read');
    reg.unmount('file__read');
    expect(reg.isMounted('file__read')).toBe(false);
    expect(reg.getMountedCount()).toBe(0);
  });

  it('unmount is a no-op for a non-existent tool', () => {
    const reg = new ToolRegistry();
    expect(() => reg.unmount('nonexistent')).not.toThrow();
  });

  it('unmount is a no-op for an already unmounted tool', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read'));
    expect(() => reg.unmount('file__read')).not.toThrow();
    expect(reg.isMounted('file__read')).toBe(false);
  });

  it('get returns the tool definition or undefined', () => {
    const reg = new ToolRegistry();
    const tool = makeTool('read');
    reg.add('file__read', tool);
    expect(reg.get('file__read')).toBe(tool);
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('listMounted returns only mounted tools as descriptors', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read', 'Read a file'));
    reg.add('file__write', makeTool('write', 'Write a file'));
    reg.add('git__status', makeTool('status', 'Git status'));
    reg.mount('file__read');
    reg.mount('git__status');

    const mounted = reg.listMounted();
    expect(mounted).toHaveLength(2);
    const names = mounted.map(t => t.name).sort();
    expect(names).toEqual(['file__read', 'git__status']);
    // Descriptors should have name, description, inputSchema, defaultHidden
    expect(mounted[0]).toHaveProperty('name');
    expect(mounted[0]).toHaveProperty('description');
    expect(mounted[0]).toHaveProperty('inputSchema');
    expect(mounted[0]).toHaveProperty('defaultHidden');
  });

  it('listUnmounted returns unmounted tools without schemas', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read', 'Read a file'));
    reg.add('file__write', makeTool('write', 'Write a file'));
    reg.mount('file__read');

    const unmounted = reg.listUnmounted();
    expect(unmounted).toHaveLength(1);
    expect(unmounted[0].name).toBe('file__write');
    expect(unmounted[0].description).toBe('Write a file');
    // Should NOT have inputSchema
    expect(unmounted[0]).not.toHaveProperty('inputSchema');
  });

  it('listUnmounted filters by plugin ID', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read'));
    reg.add('file__write', makeTool('write'));
    reg.add('git__status', makeTool('status'));

    const fileTools = reg.listUnmounted('file');
    expect(fileTools).toHaveLength(2);
    expect(fileTools.every(t => t.name.startsWith('file__'))).toBe(true);

    const gitTools = reg.listUnmounted('git');
    expect(gitTools).toHaveLength(1);
    expect(gitTools[0].name).toBe('git__status');
  });

  it('listUnmountedWithSchemas returns unmounted tools with schemas', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read', 'Read a file'));
    reg.mount('file__read');
    reg.add('file__write', makeTool('write', 'Write a file'));

    const unmounted = reg.listUnmountedWithSchemas();
    expect(unmounted).toHaveLength(1);
    expect(unmounted[0].name).toBe('file__write');
    expect(unmounted[0]).toHaveProperty('inputSchema');
  });

  it('listUnmountedWithSchemas filters by plugin ID', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read'));
    reg.add('git__status', makeTool('status'));

    const fileTools = reg.listUnmountedWithSchemas('file');
    expect(fileTools).toHaveLength(1);
    expect(fileTools[0].name).toBe('file__read');
  });

  it('getPluginIds returns sorted unique plugin IDs', () => {
    const reg = new ToolRegistry();
    reg.add('file__read', makeTool('read'));
    reg.add('file__write', makeTool('write'));
    reg.add('git__status', makeTool('status'));
    reg.add('mcp__searxng__search', makeTool('search'));
    reg.add('exec__run', makeTool('run'));

    const ids = reg.getPluginIds();
    expect(ids).toEqual(['exec', 'file', 'git', 'mcp']);
  });

  it('getPluginIds returns empty array for empty registry', () => {
    const reg = new ToolRegistry();
    expect(reg.getPluginIds()).toEqual([]);
  });

  it('getTotalCount returns total tools regardless of mount state', () => {
    const reg = new ToolRegistry();
    reg.add('a', makeTool('a'));
    reg.add('b', makeTool('b'));
    reg.add('c', makeTool('c'));
    reg.mount('a');
    expect(reg.getTotalCount()).toBe(3);
    expect(reg.getMountedCount()).toBe(1);
  });
});

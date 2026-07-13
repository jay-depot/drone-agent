import { describe, expect, it, vi } from 'vitest';
import { ToolMountingCache } from '../src/tool-mounting-cache.js';
import type {
  DroneToolDefinition,
  DronePluginRegistration,
} from '../src/plugin-system.js';

function mockRegistration(): DronePluginRegistration {
  const registered: DroneToolDefinition[] = [];
  const unregistered: string[] = [];
  return {
    registerTool: vi.fn((tool: DroneToolDefinition) => {
      registered.push(tool);
    }),
    unregisterTool: vi.fn((name: string) => {
      unregistered.push(name);
    }),
    get registered() {
      return registered;
    },
    get unregistered() {
      return unregistered;
    },
  } as unknown as DronePluginRegistration;
}

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

describe('ToolMountingCache', () => {
  it('addTool stores a tool in the available pool', () => {
    const cache = new ToolMountingCache('test');
    const tool = makeTool('server__echo', 'Echo tool');
    cache.addTool('echo', tool);
    expect(cache.listAvailable()).toHaveLength(1);
    expect(cache.listAvailable()[0].name).toBe('echo');
    expect(cache.listAvailable()[0].description).toBe('Echo tool');
  });

  it('removeTool removes a tool from the available pool', () => {
    const cache = new ToolMountingCache('test');
    cache.addTool('echo', makeTool('server__echo'));
    cache.removeTool('echo');
    expect(cache.listAvailable()).toHaveLength(0);
  });

  it('removeTool also removes from mounted set if mounted', () => {
    const cache = new ToolMountingCache('test');
    const reg = mockRegistration();
    cache.addTool('echo', makeTool('server__echo'));
    cache.mountTool('echo', reg);
    expect(cache.isMounted('echo')).toBe(true);
    cache.removeTool('echo');
    expect(cache.isMounted('echo')).toBe(false);
    expect(cache.listAvailable()).toHaveLength(0);
  });

  it('replaceTool updates the tool definition without changing mount state', () => {
    const cache = new ToolMountingCache('test');
    const tool1 = makeTool('server__echo', 'Original');
    cache.addTool('echo', tool1);
    const tool2 = makeTool('server__echo', 'Updated');
    cache.replaceTool('echo', tool2);
    expect(cache.listAvailable()[0].description).toBe('Updated');
  });

  it('mountTool registers the tool and marks it as mounted', () => {
    const cache = new ToolMountingCache('test');
    const reg = mockRegistration();
    const tool = makeTool('server__echo');
    cache.addTool('echo', tool);
    const result = cache.mountTool('echo', reg);
    expect(result).toBe(tool);
    expect(reg.registerTool).toHaveBeenCalledWith(tool);
    expect(cache.isMounted('echo')).toBe(true);
  });

  it('mountTool returns undefined for a non-existent tool', () => {
    const cache = new ToolMountingCache('test');
    const reg = mockRegistration();
    const result = cache.mountTool('nonexistent', reg);
    expect(result).toBeUndefined();
    expect(reg.registerTool).not.toHaveBeenCalled();
  });

  it('mountTool is idempotent (does not re-register if already mounted)', () => {
    const cache = new ToolMountingCache('test');
    const reg = mockRegistration();
    const tool = makeTool('server__echo');
    cache.addTool('echo', tool);
    cache.mountTool('echo', reg);
    cache.mountTool('echo', reg);
    expect(reg.registerTool).toHaveBeenCalledTimes(1);
  });

  it('unmountTool unregisters the tool using canonical name and marks it as unmounted', () => {
    const cache = new ToolMountingCache('test');
    const reg = mockRegistration();
    const tool = makeTool('server__echo');
    cache.addTool('echo', tool);
    cache.mountTool('echo', reg);
    cache.unmountTool('echo', reg);
    // The canonical name is test__server__echo (pluginId + tool.name)
    expect(reg.unregisterTool).toHaveBeenCalledWith('test__server__echo');
    expect(cache.isMounted('echo')).toBe(false);
  });

  it('unmountTool is a no-op for a tool that was not mounted', () => {
    const cache = new ToolMountingCache('test');
    const reg = mockRegistration();
    cache.addTool('echo', makeTool('server__echo'));
    cache.unmountTool('echo', reg);
    expect(reg.unregisterTool).not.toHaveBeenCalled();
  });

  it('unmountTool is a no-op for a non-existent tool', () => {
    const cache = new ToolMountingCache('test');
    const reg = mockRegistration();
    cache.unmountTool('nonexistent', reg);
    expect(reg.unregisterTool).not.toHaveBeenCalled();
  });

  it('exportMounted returns only mounted tools', () => {
    const cache = new ToolMountingCache('test');
    const reg = mockRegistration();
    cache.addTool('echo', makeTool('server__echo'));
    cache.addTool('add', makeTool('server__add'));
    cache.mountTool('echo', reg);
    const mounted = cache.exportMounted();
    expect(mounted).toHaveLength(1);
    expect(mounted[0].name).toBe('server__echo');
  });

  it('exportAvailable returns all tools', () => {
    const cache = new ToolMountingCache('test');
    cache.addTool('echo', makeTool('server__echo'));
    cache.addTool('add', makeTool('server__add'));
    expect(cache.exportAvailable()).toHaveLength(2);
  });

  it('listAvailable returns name/description pairs without schemas', () => {
    const cache = new ToolMountingCache('test');
    cache.addTool('echo', makeTool('server__echo', 'Echo tool'));
    const list = cache.listAvailable();
    expect(list).toEqual([{ name: 'echo', description: 'Echo tool' }]);
  });

  it('isMounted returns correct state', () => {
    const cache = new ToolMountingCache('test');
    const reg = mockRegistration();
    cache.addTool('echo', makeTool('server__echo'));
    expect(cache.isMounted('echo')).toBe(false);
    cache.mountTool('echo', reg);
    expect(cache.isMounted('echo')).toBe(true);
    cache.unmountTool('echo', reg);
    expect(cache.isMounted('echo')).toBe(false);
  });
});

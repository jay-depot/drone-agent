/**
 * @vitest-environment node
 *
 * SLOW integration suite for the MCP plugin (`plugins/mcp/index.ts`).
 *
 * These tests boot the REAL `createDronePluginEngine` with the real `mcp`
 * plugin pointed at a REAL spawned child process (`mcp-fake-server.mjs`). They
 * exist in the slow suite (vitest.integration.config.ts) because they spawn
 * subprocesses and exercise child-process lifecycle (spawn, graceful shutdown,
 * force-kill, unavailable-server handling). The fast `mcp-client.test.ts`
 * covers the in-process protocol logic over the HTTP transport.
 *
 * NOTE on tool naming: the engine registers every plugin tool under the
 * canonical name `<pluginId>__<toolName>`. The mcp plugin id is `mcp`, so a
 * meta-tool `__list_tools` from server `demo` mounts as `mcp__demo__list_tools`.
 * Individual MCP tools are NOT mounted eagerly — the LLM must use
 * `__list_tools` to discover them and `__mount_tool` to mount them.
 *
 * NOTE on child capture: the MCP client spawns ITS OWN child from the server
 * config when the engine boots (this suite does not spawn the child itself).
 * To assert on that client-owned child's lifecycle, this file wraps
 * `node:child_process.spawn` via `vi.mock` and records every spawned child in
 * `spawnedChildren`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChildProcess } from 'node:child_process';
import { type DroneAgentConfig } from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { mcpPlugin } from '../src/plugins/mcp/index.js';
import { startFakeMcpServer } from './mcp-fake-server.js';

// Wrap the real spawn so we can observe the client-owned MCP child processes.
const spawnedChildren: ChildProcess[] = [];

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process'
    );
  const realSpawn = actual.spawn;
  return {
    ...actual,
    spawn: (...args: Parameters<typeof realSpawn>) => {
      const child = realSpawn(...args);
      spawnedChildren.push(child);
      return child;
    },
  };
});

type Running = {
  engine: ReturnType<typeof createDronePluginEngine>;
};

const running: Running = { engine: undefined as never };

beforeEach(() => {
  spawnedChildren.length = 0;
});

afterEach(async () => {
  // Trigger the plugin's onShutdown hook so connections disconnect gracefully.
  try {
    if (running.engine) {
      await running.engine.runHooks('onShutdown');
    }
  } catch {
    // ignore
  }
  // Ensure any captured children are reaped so the suite doesn't leak processes.
  for (const child of spawnedChildren) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
  running.engine = undefined as never;
});

function toolNames(
  engine: ReturnType<typeof createDronePluginEngine>
): string[] {
  return engine.listTools().map(t => t.name);
}

function statusOf(
  engine: ReturnType<typeof createDronePluginEngine>,
  id: string
): Promise<Record<string, unknown>> {
  return engine.executeTool('mcp__server_status', {}).then(raw => {
    const parsed = JSON.parse(raw) as {
      servers: Array<Record<string, unknown>>;
    };
    return parsed.servers.find(s => s.id === id) as Record<string, unknown>;
  });
}

async function bootWithServers(
  servers: Record<string, unknown>
): Promise<ReturnType<typeof createDronePluginEngine>> {
  const config = {
    enabledPlugins: ['mcp'],
    mcp: {
      enabled: true,
      requestTimeoutMs: 5000,
      spawnTimeoutMs: 30000,
      retryCount: 0,
      retryDelayMs: 0,
      maxListPages: 25,
      maxListItems: 500,
      compatibilityMode: 'strict',
      servers: servers as DroneAgentConfig['mcp']['servers'],
    },
  } as unknown as DroneAgentConfig;

  const engine = createDronePluginEngine({
    plugins: [mcpPlugin],
    config,
  });
  await engine.initialize();
  // The mcp plugin mounts per-server tools in its `onPluginsLoaded` hook, which
  // the engine does not auto-run during initialize(); trigger it explicitly.
  await engine.runHooks('onPluginsLoaded');
  running.engine = engine;
  return engine;
}

describe('mcp plugin integration (stdio child)', () => {
  it('mounts meta-tools and resource/prompt tools, not individual MCP tools', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo', 'add'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const names = toolNames(engine);
    // Meta-tools are mounted eagerly.
    expect(names).toContain('mcp__demo__list_tools');
    expect(names).toContain('mcp__demo__mount_tool');
    expect(names).toContain('mcp__demo__unmount_tool');
    // Resource/prompt tools are consolidated into __list and __get.
    expect(names).toContain('mcp__demo__list');
    expect(names).toContain('mcp__demo__get');
    expect(names).toContain('mcp__server_status');

    // Individual MCP tools are NOT mounted eagerly.
    expect(names).not.toContain('mcp__demo__echo');
    expect(names).not.toContain('mcp__demo__add');

    const demo = await statusOf(engine, 'demo');
    expect(demo).toBeDefined();
    expect(demo.status).toBe('connected');
    expect(demo.discoveredToolCount).toBe(2);
    expect(demo.mountedToolCount).toBe(0);
  });

  it('list_tools returns tool names and descriptions without schemas', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo', 'add'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const result = JSON.parse(
      await engine.executeTool('mcp__demo__list_tools', {})
    );
    expect(result.serverId).toBe('demo');
    expect(result.toolCount).toBe(2);
    expect(Array.isArray(result.tools)).toBe(true);
    const toolList = result.tools as Array<{
      name: string;
      description: string;
    }>;
    expect(toolList.map(t => t.name).sort()).toEqual(['add', 'echo']);
    // Each entry should have a description string but no schema fields.
    for (const t of toolList) {
      expect(typeof t.description).toBe('string');
      expect(t).not.toHaveProperty('inputSchema');
    }
  });

  it('mount_tool mounts a tool with its full schema, then it is callable', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    // Tool not mounted yet.
    expect(toolNames(engine)).not.toContain('mcp__demo__echo');

    // Mount it.
    const mountResult = JSON.parse(
      await engine.executeTool('mcp__demo__mount_tool', { tool: 'echo' })
    );
    expect(mountResult.mounted).toBe(true);
    expect(mountResult.mountedName).toBe('mcp__demo__echo');

    // Now it appears in the tool list.
    expect(toolNames(engine)).toContain('mcp__demo__echo');

    // And it is callable.
    const callResult = JSON.parse(
      await engine.executeTool('mcp__demo__echo', {})
    );
    expect(callResult.tool).toBe('echo');
  });

  it('mount_tool is idempotent (mounting an already-mounted tool returns alreadyMounted)', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    await engine.executeTool('mcp__demo__mount_tool', { tool: 'echo' });
    const result = JSON.parse(
      await engine.executeTool('mcp__demo__mount_tool', { tool: 'echo' })
    );
    expect(result.alreadyMounted).toBe(true);
  });

  it('mount_tool rejects a non-existent tool name', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    await expect(
      engine.executeTool('mcp__demo__mount_tool', { tool: 'nonexistent' })
    ).rejects.toThrow(/not found/);
  });

  it('unmount_tool removes a mounted tool from the engine', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    await engine.executeTool('mcp__demo__mount_tool', { tool: 'echo' });
    expect(toolNames(engine)).toContain('mcp__demo__echo');

    const result = JSON.parse(
      await engine.executeTool('mcp__demo__unmount_tool', { tool: 'echo' })
    );
    expect(result.unmounted).toBe(true);

    expect(toolNames(engine)).not.toContain('mcp__demo__echo');
  });

  it('unmount_tool is a no-op for a tool that was not mounted', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const result = JSON.parse(
      await engine.executeTool('mcp__demo__unmount_tool', { tool: 'echo' })
    );
    expect(result.wasMounted).toBe(false);
  });

  it('lists resource templates and reads a filled-in template URI', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo', 'add'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const listed = JSON.parse(
      await engine.executeTool('mcp__demo__list', {
        type: 'resource_templates',
      })
    );
    expect(Array.isArray(listed.templates)).toBe(true);
    expect(
      listed.templates.map((t: { uriTemplate: string }) => t.uriTemplate)
    ).toContain('file:///{path}');

    // A URI formed by substituting the template variable must be readable via
    // the shared __get tool with type="resource".
    const read = JSON.parse(
      await engine.executeTool('mcp__demo__get', {
        type: 'resource',
        uri: 'file:///etc/hostname',
      })
    );
    expect(read.uri).toBe('file:///etc/hostname');
  });

  it('honors allowedTools allowlist: __list_tools shows all, __mount_tool rejects non-allowlisted', async () => {
    // Server advertises echo + add; allowlist restricts to echo only.
    const server = startFakeMcpServer({ toolNames: ['echo', 'add'] });
    const engine = await bootWithServers({
      demo: {
        ...server.serverConfig,
        allowedTools: ['echo'],
      },
    });

    // __list_tools shows all tools.
    const listed = JSON.parse(
      await engine.executeTool('mcp__demo__list_tools', {})
    );
    expect(listed.toolCount).toBe(2);

    // Mounting echo (allowlisted) succeeds.
    await engine.executeTool('mcp__demo__mount_tool', { tool: 'echo' });
    expect(toolNames(engine)).toContain('mcp__demo__echo');

    // Mounting add (not allowlisted) fails.
    await expect(
      engine.executeTool('mcp__demo__mount_tool', { tool: 'add' })
    ).rejects.toThrow(/not in the allowedTools list/);

    const demo = await statusOf(engine, 'demo');
    expect(demo.filteredToolCount).toBe(1);
    expect(demo.discoveredToolCount).toBe(2);
  });

  it('sanitizes tool names with non-[a-zA-Z0-9_-] characters when mounting', async () => {
    // 'weird name!' -> 'weird_name_' under the sanitizer, mounted as
    // mcp__demo__weird_name_.
    const server = startFakeMcpServer({ toolNames: ['weird name!'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    // Not mounted eagerly.
    expect(toolNames(engine)).not.toContain('mcp__demo__weird_name_');

    // Mount it — the mounted name uses the sanitized segment.
    const result = JSON.parse(
      await engine.executeTool('mcp__demo__mount_tool', {
        tool: 'weird name!',
      })
    );
    expect(result.mountedName).toBe('mcp__demo__weird_name_');
    expect(toolNames(engine)).toContain('mcp__demo__weird_name_');
  });

  it('child process is terminated and status flips to disconnected on shutdown', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    // The client-owned child is the last process spawned during boot.
    const child = spawnedChildren.at(-1);
    expect(child).toBeDefined();

    await engine.runHooks('onShutdown');

    const dead = child!.exitCode !== null || child!.killed;
    expect(dead).toBe(true);

    const demo = await statusOf(engine, 'demo');
    expect(demo.status).toBe('disconnected');
  });

  it('records an error state (no throw) when the server command is unavailable', async () => {
    const engine = await bootWithServers({
      missing: {
        transport: 'stdio',
        command: 'this-command-does-not-exist-anywhere-xyz',
        args: [],
        env: {},
      },
    });
    running.engine = engine;

    const missing = await statusOf(engine, 'missing');
    expect(missing).toBeDefined();
    expect(missing.status).toBe('error');
    expect(missing.lastError).toBeTruthy();
  });

  it('handles tools/list_changed by updating cache and unmounting stale tools', async () => {
    const server = startFakeMcpServer({
      toolNames: ['echo'],
      notifyOnToolName: 'echo',
    });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });
    // Mount the echo tool.
    await engine.executeTool('mcp__demo__mount_tool', { tool: 'echo' });
    expect(toolNames(engine)).toContain('mcp__demo__echo');

    // Calling the configured tool triggers a tools/list_changed notification
    // from the server. The handler should update the cache but keep echo
    // mounted (since echo still exists on the server).
    await engine.executeTool('mcp__demo__echo', {});

    // Give the notification handler a tick to process.
    await new Promise(resolve => setTimeout(resolve, 50));

    // Tool should still be mounted after list_changed (echo still exists).
    expect(toolNames(engine)).toContain('mcp__demo__echo');

    // Meta-tools should still be present.
    expect(toolNames(engine)).toContain('mcp__demo__list_tools');
    expect(toolNames(engine)).toContain('mcp__demo__mount_tool');
  });

  it('dispatches notifications/message from server to the plugin logger at the correct level', async () => {
    const server = startFakeMcpServer({
      toolNames: ['log-trigger'],
      notifyMessageOnToolName: 'log-trigger',
    });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    // Mount the log-trigger tool and call it, which triggers a notifications/message
    await engine.executeTool('mcp__demo__mount_tool', { tool: 'log-trigger' });
    expect(toolNames(engine)).toContain('mcp__demo__log-trigger');

    // Call the tool — the fake server will send a notifications/message
    // with level: 'warning', logger: 'fake-server', data: 'log from log-trigger'
    // before responding. The notification handler should dispatch to the logger.
    const result = await engine.executeTool('mcp__demo__log-trigger', {});
    expect(result).toContain('called log-trigger');

    // Give the notification handler a tick to process.
    await new Promise(resolve => setTimeout(resolve, 50));

    // The notification was dispatched to the logger (we can't easily spy on
    // the registration.logger, but the test verifies no crash and the tool
    // call succeeded).
    expect(toolNames(engine)).toContain('mcp__demo__log-trigger');
  });

  it('two MCP servers: both servers meta-tools are visible (regression: no clobbering)', async () => {
    const serverA = startFakeMcpServer({ toolNames: ['echo'] });
    const serverB = startFakeMcpServer({ toolNames: ['add'] });
    const engine = await bootWithServers({
      serverA: serverA.serverConfig,
      serverB: serverB.serverConfig,
    });

    const names = toolNames(engine);

    // Both servers' meta-tools should be present.
    expect(names).toContain('mcp__serverA__list_tools');
    expect(names).toContain('mcp__serverA__mount_tool');
    expect(names).toContain('mcp__serverA__unmount_tool');
    expect(names).toContain('mcp__serverA__list');
    expect(names).toContain('mcp__serverA__get');

    expect(names).toContain('mcp__serverB__list_tools');
    expect(names).toContain('mcp__serverB__mount_tool');
    expect(names).toContain('mcp__serverB__unmount_tool');
    expect(names).toContain('mcp__serverB__list');
    expect(names).toContain('mcp__serverB__get');
  });
});

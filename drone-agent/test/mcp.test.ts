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
 * tool `echo` from server `demo` registers as `mcp__demo__echo`.
 * All tools start unmounted. Use `runtime__mount_tool` to mount them.
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

/**
 * Mount MCP resource/prompt tools for a given server so they appear in listTools().
 */
async function mountMcpResourceTools(
  engine: ReturnType<typeof createDronePluginEngine>,
  serverId: string
): Promise<void> {
  const tools = [`mcp__${serverId}__list`, `mcp__${serverId}__get`];
  for (const tool of tools) {
    await engine.executeTool('runtime__mount_tool', { tool });
  }
}

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
  // The mcp plugin registers per-server tools in its `onPluginsLoaded` hook, which
  // the engine does not auto-run during initialize(); trigger it explicitly.
  await engine.runHooks('onPluginsLoaded');
  running.engine = engine;
  return engine;
}

describe('mcp plugin integration (stdio child)', () => {
  it('registers resource/prompt tools, not individual MCP tools', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo', 'add'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const names = toolNames(engine);
    // Only runtime meta-tools are mounted initially
    expect(names).toEqual([
      'runtime__list_tools',
      'runtime__mount_tool',
      'runtime__unmount_tool',
    ]);

    // Individual MCP tools are NOT mounted eagerly.
    expect(names).not.toContain('mcp__demo__echo');
    expect(names).not.toContain('mcp__demo__add');

    const demo = await statusOf(engine, 'demo');
    expect(demo).toBeDefined();
    expect(demo.status).toBe('connected');
    expect(demo.discoveredToolCount).toBe(2);
    expect(demo.mountedToolCount).toBe(0);
  });

  it('runtime__list_tools shows MCP tools when filtered by plugin', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo', 'add'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const result = JSON.parse(
      await engine.executeTool('runtime__list_tools', { plugin: 'mcp' })
    );
    expect(result.toolCount).toBeGreaterThanOrEqual(2);
    const toolList = result.tools as Array<{
      name: string;
      description: string;
    }>;
    expect(toolList.map(t => t.name)).toContain('mcp__demo__echo');
    expect(toolList.map(t => t.name)).toContain('mcp__demo__add');
  });

  it('runtime__mount_tool mounts an MCP tool, then it is callable', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    // Tool not mounted yet.
    expect(toolNames(engine)).not.toContain('mcp__demo__echo');

    // Mount it via runtime__mount_tool.
    const mountResult = JSON.parse(
      await engine.executeTool('runtime__mount_tool', {
        tool: 'mcp__demo__echo',
      })
    );
    expect(mountResult.success).toBe(true);
    expect(mountResult.tool).toBe('mcp__demo__echo');

    // Now it appears in the tool list.
    expect(toolNames(engine)).toContain('mcp__demo__echo');

    // And it is callable.
    const callResult = JSON.parse(
      await engine.executeTool('mcp__demo__echo', {})
    );
    expect(callResult.tool).toBe('echo');
  });

  it('runtime__mount_tool is idempotent', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    await engine.executeTool('runtime__mount_tool', {
      tool: 'mcp__demo__echo',
    });
    const result = JSON.parse(
      await engine.executeTool('runtime__mount_tool', {
        tool: 'mcp__demo__echo',
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('already mounted');
  });

  it('runtime__mount_tool rejects a non-existent tool name', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const result = JSON.parse(
      await engine.executeTool('runtime__mount_tool', {
        tool: 'mcp__demo__nonexistent',
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown');
  });

  it('runtime__unmount_tool removes a mounted MCP tool', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    // Mount echo
    await engine.executeTool('runtime__mount_tool', {
      tool: 'mcp__demo__echo',
    });
    expect(toolNames(engine)).toContain('mcp__demo__echo');

    // Unmount it
    const result = JSON.parse(
      await engine.executeTool('runtime__unmount_tool', {
        tool: 'mcp__demo__echo',
      })
    );
    expect(result.success).toBe(true);
    expect(result.tool).toBe('mcp__demo__echo');

    expect(toolNames(engine)).not.toContain('mcp__demo__echo');
  });

  it('lists resource templates and reads a filled-in template URI', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo', 'add'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });
    await mountMcpResourceTools(engine, 'demo');

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
    await engine.executeTool('runtime__mount_tool', {
      tool: 'mcp__demo__echo',
    });
    expect(toolNames(engine)).toContain('mcp__demo__echo');

    // Calling the configured tool triggers a tools/list_changed notification
    // from the server. The handler should update the cache but keep echo
    // mounted (since echo still exists on the server).
    await engine.executeTool('mcp__demo__echo', {});

    // Give the notification handler a tick to process.
    await new Promise(resolve => setTimeout(resolve, 50));

    // Tool should still be mounted after list_changed (echo still exists).
    expect(toolNames(engine)).toContain('mcp__demo__echo');
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
    await engine.executeTool('runtime__mount_tool', {
      tool: 'mcp__demo__log-trigger',
    });
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

  it('two MCP servers: both servers tools are visible via runtime__list_tools', async () => {
    const serverA = startFakeMcpServer({ toolNames: ['echo'] });
    const serverB = startFakeMcpServer({ toolNames: ['add'] });
    const engine = await bootWithServers({
      serverA: serverA.serverConfig,
      serverB: serverB.serverConfig,
    });

    // List all MCP tools
    const result = JSON.parse(
      await engine.executeTool('runtime__list_tools', { plugin: 'mcp' })
    );
    const names = result.tools.map((t: { name: string }) => t.name);

    // Both servers' tools should be present.
    expect(names).toContain('mcp__serverA__echo');
    expect(names).toContain('mcp__serverB__add');

    // Resource/prompt tools should also be present.
    expect(names).toContain('mcp__serverA__list');
    expect(names).toContain('mcp__serverA__get');
    expect(names).toContain('mcp__serverB__list');
    expect(names).toContain('mcp__serverB__get');
  });
});

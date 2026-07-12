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
 * PHASE 1 RULE: these tests encode CURRENT plugin behavior so they pass today.
 *
 * NOTE on tool naming: the engine registers every plugin tool under the
 * canonical name `<pluginId>__<toolName>`. The mcp plugin id is `mcp`, so a
 * tool `echo` from server `demo` mounts as `mcp__demo__echo`. These tests
 * assert that CURRENT naming (the later fix-phases may restructure it).
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
  it('mounts demo__* tools and resource/prompt tools, reports connected', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo', 'add'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const names = toolNames(engine);
    // Current naming: <pluginId>__<serverId>__<toolName>.
    expect(names).toContain('mcp__demo__echo');
    expect(names).toContain('mcp__demo__add');
    expect(names).toContain('mcp__demo__list_resources');
    expect(names).toContain('mcp__demo__read_resource');
    expect(names).toContain('mcp__demo__list_prompts');
    expect(names).toContain('mcp__demo__get_prompt');
    expect(names).toContain('mcp__demo__list_resource_templates');
    expect(names).toContain('mcp__server_status');

    const demo = await statusOf(engine, 'demo');
    expect(demo).toBeDefined();
    expect(demo.status).toBe('connected');
  });

  it('executes a mounted tool and returns its result', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const result = JSON.parse(await engine.executeTool('mcp__demo__echo', {}));
    expect(result.tool).toBe('echo');
  });

  it('lists resource templates and reads a filled-in template URI', async () => {
    const server = startFakeMcpServer({ toolNames: ['echo', 'add'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const listed = JSON.parse(
      await engine.executeTool('mcp__demo__list_resource_templates', {})
    );
    expect(Array.isArray(listed.templates)).toBe(true);
    expect(
      listed.templates.map((t: { uriTemplate: string }) => t.uriTemplate)
    ).toContain('file:///{path}');

    // A URI formed by substituting the template variable must be readable via
    // the shared read_resource tool (the spec has no resources/templates/read).
    const read = JSON.parse(
      await engine.executeTool('mcp__demo__read_resource', {
        uri: 'file:///etc/hostname',
      })
    );
    expect(read.uri).toBe('file:///etc/hostname');
  });

  it('honors allowedTools allowlist and sets filteredToolCount', async () => {
    // Server advertises echo + add; allowlist restricts to echo only.
    const server = startFakeMcpServer({ toolNames: ['echo', 'add'] });
    const engine = await bootWithServers({
      demo: {
        ...server.serverConfig,
        allowedTools: ['echo'],
      },
    });

    const names = toolNames(engine);
    expect(names).toContain('mcp__demo__echo');
    expect(names).not.toContain('mcp__demo__add');

    const demo = await statusOf(engine, 'demo');
    expect(demo.mountedToolCount).toBe(1);
    expect(demo.filteredToolCount).toBe(1);
    expect(demo.discoveredToolCount).toBe(2);
  });

  it('sanitizes tool names with non-[a-zA-Z0-9_-] characters', async () => {
    // 'weird name!' -> 'weird_name_' under the current sanitizer, mounted as
    // mcp__demo__weird_name_.
    const server = startFakeMcpServer({ toolNames: ['weird name!'] });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    const names = toolNames(engine);
    expect(names).toContain('mcp__demo__weird_name_');
    expect(names).not.toContain('mcp__demo__weird name!');
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

  it('re-mounts tools when server sends a notification via stdio', async () => {
    const server = startFakeMcpServer({
      toolNames: ['echo'],
      notifyOnToolName: 'echo',
    });
    const engine = await bootWithServers({
      demo: server.serverConfig,
    });

    // Sanity: tool is mounted.
    let names = toolNames(engine);
    expect(names).toContain('mcp__demo__echo');

    // Calling the configured tool triggers a notification from the server.
    // The client's onNotification handler should re-mount tools seamlessly.
    await engine.executeTool('mcp__demo__echo', {});

    // Give the notification handler a tick to process.
    await new Promise(resolve => setTimeout(resolve, 50));

    // Tool should still be mounted after re-mount.
    names = toolNames(engine);
    expect(names).toContain('mcp__demo__echo');
  });
});
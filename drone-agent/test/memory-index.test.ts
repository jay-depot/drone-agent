import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  createDefaultAgentConfig,
  type DronePluginRegistration,
  type DronePromptFragment,
  type DroneWorkflow,
} from 'drone-core';
import { memoryPlugin } from '../src/plugins/memory/index.js';
import type { DroneMemoryCapability } from '../src/plugins/memory/types.js';

/**
 * Build a mock registration that tools and hooks can call.
 * Captures offers, tools, prompt fragments, help, workflows, hooks.
 */
function createMockRegistration(): {
  registration: DronePluginRegistration;
  captured: {
    capabilities: Map<string, unknown>;
    tools: { name: string; execute: Function }[];
    prompts: { key: string; phase: string }[];
    help: string[];
    workflows: DroneWorkflow[];
    hooks: Record<string, Function[]>;
  };
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
} {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const captured = {
    capabilities: new Map<string, unknown>(),
    tools: [] as { name: string; execute: Function }[],
    prompts: [] as {
      key: string;
      phase: string;
      render: () => Promise<string | false>;
    }[],
    help: [] as string[],
    workflows: [] as DroneWorkflow[],
    hooks: {
      onPluginsLoaded: [] as Function[],
      onSessionStart: [] as Function[],
      onBeforePrompt: [] as Function[],
      onAfterToolCall: [] as Function[],
      onConversationEvent: [] as Function[],
      onSessionClear: [] as Function[],
      onShutdown: [] as Function[],
      onSessionSafetyTrimWillRun: [] as Function[],
      onSessionSafetyTrimApplied: [] as Function[],
    },
  };

  const registration: DronePluginRegistration = {
    logger,
    getConfig: () => createDefaultAgentConfig(),
    registerTool: tool => {
      captured.tools.push(tool);
    },
    registerPromptFragment: fragment => {
      captured.prompts.push(fragment);
    },
    registerHelp: help => {
      captured.help.push(help);
    },
    registerSlashCommand: () => {},
    unregisterPluginTools: () => {},
    registerWorkflow: workflow => {
      captured.workflows.push(workflow);
    },
    hooks: {
      onPluginsLoaded: cb => captured.hooks.onPluginsLoaded.push(cb),
      onSessionStart: cb => captured.hooks.onSessionStart.push(cb),
      onBeforePrompt: cb => captured.hooks.onBeforePrompt.push(cb),
      onAfterToolCall: cb => captured.hooks.onAfterToolCall.push(cb),
      onConversationEvent: cb => captured.hooks.onConversationEvent.push(cb),
      onSessionClear: cb => captured.hooks.onSessionClear.push(cb),
      onShutdown: cb => captured.hooks.onShutdown.push(cb),
      onSessionSafetyTrimWillRun: cb =>
        captured.hooks.onSessionSafetyTrimWillRun.push(cb),
      onSessionSafetyTrimApplied: cb =>
        captured.hooks.onSessionSafetyTrimApplied.push(cb),
    },
    offer: <T>(capability: T) => {
      captured.capabilities.set('memory', capability);
    },
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };

  return { registration, captured, logger };
}

describe('memoryPlugin', () => {
  // Use a temp directory instead of process.cwd() to avoid deleting
  // real project memories during test runs.
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'drone-memory-test-'));
    // Ensure .drone-agent directory exists for the memory plugin
    await mkdir(path.join(tmpDir, '.drone-agent'), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct metadata', () => {
    expect(memoryPlugin.metadata.id).toBe('memory');
    expect(memoryPlugin.metadata.name).toBe('Memory');
    expect(memoryPlugin.metadata.defaultEnabled).toBe(false);
  });

  it('registers tools, prompt fragment, and capability', async () => {
    const { registration, captured } = createMockRegistration();
    await memoryPlugin.register(registration);

    // Tools
    const toolNames = captured.tools.map(t => t.name);
    expect(toolNames).toContain('store');
    expect(toolNames).toContain('recall');
    expect(toolNames).toContain('list');
    expect(toolNames).toContain('search');
    expect(toolNames).toContain('delete');
    expect(new Set(toolNames).size).toBe(toolNames.length); // no duplicates

    // Prompt fragment
    expect(captured.prompts).toHaveLength(1);
    expect(captured.prompts[0].key).toBe('memory');
    expect(captured.prompts[0].phase).toBe('header');

    // Capability
    expect(captured.capabilities.has('memory')).toBe(true);
    const cap = captured.capabilities.get('memory') as DroneMemoryCapability;
    expect(cap).toBeDefined();
    expect(typeof cap.store).toBe('function');
    expect(typeof cap.recall).toBe('function');
    expect(typeof cap.list).toBe('function');
    expect(typeof cap.search).toBe('function');
    expect(typeof cap.delete).toBe('function');

    // Help
    expect(captured.help.length).toBeGreaterThan(0);
    expect(captured.help[0]).toContain('Memory');
  });

  it('registers hooks: onPluginsLoaded', async () => {
    const { registration, captured } = createMockRegistration();
    await memoryPlugin.register(registration);

    expect(captured.hooks.onPluginsLoaded).toHaveLength(1);
    expect(captured.hooks.onShutdown).toHaveLength(0); // no more auto-save
    expect(captured.hooks.onBeforePrompt).toHaveLength(0); // prompt fragment, not hook
  });

  it('offers a working DroneMemoryCapability', async () => {
    const { registration, captured } = createMockRegistration();
    await memoryPlugin.register(registration);

    const cap = captured.capabilities.get('memory') as DroneMemoryCapability;

    // store and recall
    const stored = await cap.store('test-key', 'hello world', ['test-tag']);
    expect(stored.key).toBe('test-key');
    expect(stored.tags).toEqual(['test-tag']);

    const recalled = await cap.recall('test-key');
    expect(recalled).not.toBeNull();
    expect(recalled!.value).toBe('hello world');

    // list
    const list = await cap.list();
    expect(list.length).toBeGreaterThanOrEqual(1);

    // search
    const searchResults = await cap.search('test-tag');
    expect(searchResults.length).toBeGreaterThanOrEqual(1);

    // delete
    const deleted = await cap.delete('test-key');
    expect(deleted).toBe(true);

    const afterDelete = await cap.recall('test-key');
    expect(afterDelete).toBeNull();
  });

  it('tools return proper error for missing keys', async () => {
    const { registration, captured } = createMockRegistration();
    await memoryPlugin.register(registration);

    const recallTool = captured.tools.find(t => t.name === 'recall')!;
    const result = await recallTool.execute({ key: 'nonexistent' });
    const parsed = JSON.parse(result);
    expect(parsed.entry).toBeNull();
  });

  it('list tool accepts optional prefix', async () => {
    const { registration, captured } = createMockRegistration();
    await memoryPlugin.register(registration);

    const cap = captured.capabilities.get('memory') as DroneMemoryCapability;
    await cap.store('session:abc', '1');
    await cap.store('session:xyz', '2');

    const listTool = captured.tools.find(t => t.name === 'list')!;
    const result = await listTool.execute({ prefix: 'session:' });
    const parsed = JSON.parse(result);
    expect(parsed.count).toBe(2);
  });

  it('prompt fragment renders when memories exist', async () => {
    const { registration, captured } = createMockRegistration();
    await memoryPlugin.register(registration);

    const cap = captured.capabilities.get('memory') as DroneMemoryCapability;
    await cap.store('fact-1', 'hello');

    const fragment = captured.prompts[0] as DronePromptFragment;
    const rendered = await fragment.render();
    expect(typeof rendered).toBe('string');
    expect(rendered).toContain('Project Memories');
    expect(rendered).toContain('fact-1');
  });
});

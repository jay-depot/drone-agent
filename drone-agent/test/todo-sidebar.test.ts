/**
 * Tests for the todo plugin's mid-panel widget capability.
 *
 * The todo plugin offers a mid-panel widget via `registration.offer()`.
 * The widget's `getContent()` returns a summary line describing the
 * current todo list. These tests verify the content formatting
 * independently of the TUI.
 */

import { describe, expect, it } from 'vitest';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { todoPlugin } from '../src/plugins/todo/index.js';
import { createDefaultAgentConfig } from 'drone-core';
import { silentLogger } from './helpers.js';

type MidPanelWidgetShape = {
  id: string;
  label: string;
  getContent: () => string[];
};

async function createEngineWithTodo(): Promise<{
  engine: ReturnType<typeof createDronePluginEngine>;
  executeTool: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<string | import('drone-core').DroneToolResult>;
}> {
  const engine = createDronePluginEngine({
    plugins: [todoPlugin],
    config: { ...createDefaultAgentConfig(), enabledPlugins: ['todo'] },
    logger: silentLogger(),
  });
  await engine.initialize();
  return {
    engine,
    executeTool: async (name, input) =>
      engine.executeTool(`todo__${name}`, input),
  };
}

describe('todo mid-panel widget', () => {
  it('returns empty content when the todo list is empty', async () => {
    const { engine } = await createEngineWithTodo();
    const widget = engine.getCapability<MidPanelWidgetShape>('todo');
    expect(widget).toBeDefined();
    expect(widget!.id).toBe('todo');
    expect(widget!.label).toBe('TODO');
    expect(widget!.getContent()).toEqual([]);
  });

  it('returns summary with 0 / 1 for a single pending item', async () => {
    const { engine, executeTool } = await createEngineWithTodo();
    await executeTool('manage_list', {
      action: 'add_item',
      title: 'Fix login bug',
    });
    const widget = engine.getCapability<MidPanelWidgetShape>('todo');
    const content = widget!.getContent();
    expect(content).toEqual(['0 / 1']);
  });

  it('shows correct completed count with mixed status items', async () => {
    const { engine, executeTool } = await createEngineWithTodo();
    await executeTool('manage_list', { action: 'add_item', title: 'Task A' });
    await executeTool('manage_list', { action: 'add_item', title: 'Task B' });
    await executeTool('manage_list', { action: 'add_item', title: 'Task C' });
    // Mark one as in-progress and one as completed
    await executeTool('manage_list', {
      action: 'mark_in_progress',
      id: '1',
    });
    await executeTool('manage_list', {
      action: 'mark_completed',
      id: '2',
    });

    const widget = engine.getCapability<MidPanelWidgetShape>('todo');
    const content = widget!.getContent();
    // Summary: 1 / 3 : 1 WORKING (one completed, one in-progress)
    expect(content).toEqual(['1 / 3 : 1 WORKING']);
  });

  it('shows correct count when all items completed', async () => {
    const { engine, executeTool } = await createEngineWithTodo();
    await executeTool('manage_list', { action: 'add_item', title: 'Task A' });
    await executeTool('manage_list', { action: 'add_item', title: 'Task B' });
    await executeTool('manage_list', {
      action: 'mark_completed',
      id: '1',
    });
    await executeTool('manage_list', {
      action: 'mark_completed',
      id: '2',
    });

    const widget = engine.getCapability<MidPanelWidgetShape>('todo');
    const content = widget!.getContent();
    expect(content).toEqual(['2 / 2']);
  });
});

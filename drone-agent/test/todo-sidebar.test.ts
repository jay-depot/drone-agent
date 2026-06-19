/**
 * Tests for the todo plugin's sidebar widget capability.
 *
 * The todo plugin offers a sidebar widget via `registration.offer()`.
 * The widget's `getContent()` returns lines describing the current
 * todo list. These tests verify the content formatting independently
 * of the TUI.
 */

import { describe, expect, it } from 'vitest';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { todoPlugin } from '../src/plugins/todo.js';
import { createDefaultAgentConfig } from 'drone-core';
import { silentLogger, createTestPlugin } from './helpers.js';

type SidebarWidgetShape = {
  id: string;
  label: string;
  getContent: () => string[];
};

async function createEngineWithTodo(): Promise<{
  engine: ReturnType<typeof createDronePluginEngine>;
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
}> {
  const engine = createDronePluginEngine({
    plugins: [todoPlugin],
    config: { ...createDefaultAgentConfig(), enabledPlugins: ['todo'] },
    logger: silentLogger(),
  });
  await engine.initialize();
  return {
    engine,
    executeTool: async (name, input) => engine.executeTool(`todo.${name}`, input),
  };
}

describe('todo sidebar widget', () => {
  it('returns empty content when the todo list is empty', async () => {
    const { engine } = await createEngineWithTodo();
    const widget = engine.getCapability<SidebarWidgetShape>('todo');
    expect(widget).toBeDefined();
    expect(widget!.id).toBe('todo');
    expect(widget!.label).toBe('TODO');
    expect(widget!.getContent()).toEqual([]);
  });

  it('returns lines for a single pending item', async () => {
    const { engine, executeTool } = await createEngineWithTodo();
    await executeTool('manage_list', {
      action: 'add_item',
      title: 'Fix login bug',
    });
    const widget = engine.getCapability<SidebarWidgetShape>('todo');
    const content = widget!.getContent();
    expect(content.length).toBeGreaterThanOrEqual(2);
    // First line should have the item count summary
    expect(content[0]).toContain('1 items');
    expect(content[0]).toContain('1 active');
    // There should be a line with the item title
    const itemLines = content.slice(1);
    expect(itemLines.some(l => l.includes('Fix login bug'))).toBe(true);
    // The pending item should use the ○ icon
    expect(itemLines.some(l => l.includes('○'))).toBe(true);
  });

  it('shows correct active count with mixed status items', async () => {
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

    const widget = engine.getCapability<SidebarWidgetShape>('todo');
    const content = widget!.getContent();
    // Summary: 3 items (2 active — pending + in_progress)
    expect(content[0]).toContain('3 items');
    expect(content[0]).toContain('2 active');
  });

  it('uses correct icons for each status', async () => {
    const { engine, executeTool } = await createEngineWithTodo();
    await executeTool('manage_list', { action: 'add_item', title: 'Pending' });
    await executeTool('manage_list', {
      action: 'add_item',
      title: 'In Progress',
    });
    await executeTool('manage_list', {
      action: 'add_item',
      title: 'Done',
    });
    await executeTool('manage_list', {
      action: 'mark_in_progress',
      id: '2',
    });
    await executeTool('manage_list', {
      action: 'mark_completed',
      id: '3',
    });

    const widget = engine.getCapability<SidebarWidgetShape>('todo');
    const content = widget!.getContent();
    const itemLines = content.slice(1);
    // Pending: ○ icon
    expect(itemLines[0]).toContain('○');
    expect(itemLines[0]).toContain('Pending');
    // In progress: ▶ icon
    expect(itemLines[1]).toContain('▶');
    expect(itemLines[1]).toContain('In Progress');
    // Completed: ✓ icon
    expect(itemLines[2]).toContain('✓');
    expect(itemLines[2]).toContain('Done');
  });

  it('truncates long titles to fit sidebar', async () => {
    const { engine, executeTool } = await createEngineWithTodo();
    const longTitle =
      'This is a very long title that should be truncated to fit in the narrow sidebar column';
    await executeTool('manage_list', {
      action: 'add_item',
      title: longTitle,
    });
    const widget = engine.getCapability<SidebarWidgetShape>('todo');
    const content = widget!.getContent();
    const itemLines = content.slice(1);
    expect(itemLines[0].length).toBeLessThanOrEqual(22); // 1 space + icon + space + 18 chars + … = 22
  });
});
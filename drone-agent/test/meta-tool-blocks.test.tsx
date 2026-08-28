/**
 * Tests for the reusable meta-tool render components:
 * ListToolsBlock, MountToolBlock, UnmountToolBlock.
 *
 * Each component is rendered with a mock ToolRenderState using
 * ink-testing-library, and the output is checked for expected text.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ListToolsBlock } from '../src/tui/components/ListToolsBlock.js';
import { MountToolBlock } from '../src/tui/components/MountToolBlock.js';
import { UnmountToolBlock } from '../src/tui/components/UnmountToolBlock.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { ToolRenderState } from 'drone-core';

const scheme = DEFAULT_GRAYSCALE_SCHEME;

function makeState(overrides: Partial<ToolRenderState> = {}): ToolRenderState {
  return {
    name: 'git__list_tools',
    arguments: {},
    status: 'done',
    scheme: scheme as unknown,
    ...overrides,
  };
}

// ── ListToolsBlock ────────────────────────────────────────────────────

describe('ListToolsBlock', () => {
  it('shows running state', () => {
    const state = makeState({
      name: 'git__list_tools',
      status: 'running',
    });
    const { lastFrame } = render(<ListToolsBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('git__list_tools');
  });

  it('shows done state with tools', () => {
    const state = makeState({
      name: 'swarm__list_tools',
      result: JSON.stringify({
        toolCount: 2,
        tools: [
          { name: 'status', description: 'Show working tree status.' },
          { name: 'diff', description: 'Show a diff.' },
        ],
      }),
    });
    const { lastFrame } = render(<ListToolsBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('swarm__list_tools');
    expect(lastFrame()).toContain('2 tools');
    expect(lastFrame()).toContain('status');
    expect(lastFrame()).toContain('Show working tree status.');
    expect(lastFrame()).toContain('diff');
    expect(lastFrame()).toContain('Show a diff.');
  });

  it('shows singular "1 tool" for a single tool', () => {
    const state = makeState({
      result: JSON.stringify({
        toolCount: 1,
        tools: [{ name: 'status', description: 'Show status.' }],
      }),
    });
    const { lastFrame } = render(<ListToolsBlock state={state} />);
    expect(lastFrame()).toContain('1 tool');
    expect(lastFrame()).not.toContain('2 tools');
  });

  it('shows done state with 0 tools', () => {
    const state = makeState({
      result: JSON.stringify({ toolCount: 0, tools: [] }),
    });
    const { lastFrame } = render(<ListToolsBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('0 tools');
  });

  it('shows error state', () => {
    const state = makeState({
      status: 'error',
      result: 'Something went wrong',
    });
    const { lastFrame } = render(<ListToolsBlock state={state} />);
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('Something went wrong');
  });

  it('falls back to raw result when JSON is unparseable', () => {
    const state = makeState({
      result: 'not json',
    });
    const { lastFrame } = render(<ListToolsBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('not json');
  });
});

// ── MountToolBlock ───────────────────────────────────────────────────

describe('MountToolBlock', () => {
  it('shows running state with tool argument', () => {
    const state = makeState({
      name: 'git__mount_tool',
      arguments: { tool: 'status' },
      status: 'running',
    });
    const { lastFrame } = render(<MountToolBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('git__mount_tool(status)');
  });

  it('shows success state with description', () => {
    const state = makeState({
      name: 'swarm__mount_tool',
      result: JSON.stringify({
        success: true,
        tool: 'wiki_read',
        description: 'Read a wiki page.',
      }),
    });
    const { lastFrame } = render(<MountToolBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('wiki_read');
    expect(lastFrame()).toContain('Read a wiki page.');
  });

  it('shows success state without description', () => {
    const state = makeState({
      name: 'mcp__demo__mount_tool',
      result: JSON.stringify({
        success: true,
        tool: 'echo',
      }),
    });
    const { lastFrame } = render(<MountToolBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('echo');
  });

  it('shows failure state', () => {
    const state = makeState({
      name: 'git__mount_tool',
      result: JSON.stringify({
        success: false,
        error: 'Unknown tool: nonexistent',
      }),
    });
    const { lastFrame } = render(<MountToolBlock state={state} />);
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('Unknown tool: nonexistent');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'git__mount_tool',
      status: 'error',
      result: 'Something went wrong',
    });
    const { lastFrame } = render(<MountToolBlock state={state} />);
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('Something went wrong');
  });

  it('falls back to raw result when JSON is unparseable', () => {
    const state = makeState({
      name: 'git__mount_tool',
      result: 'not json',
    });
    const { lastFrame } = render(<MountToolBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('not json');
  });
});

// ── UnmountToolBlock ─────────────────────────────────────────────────

describe('UnmountToolBlock', () => {
  it('shows running state with tool argument', () => {
    const state = makeState({
      name: 'git__unmount_tool',
      arguments: { tool: 'status' },
      status: 'running',
    });
    const { lastFrame } = render(<UnmountToolBlock state={state} />);
    expect(lastFrame()).toContain('…');
    expect(lastFrame()).toContain('git__unmount_tool(status)');
  });

  it('shows success state', () => {
    const state = makeState({
      name: 'swarm__unmount_tool',
      result: JSON.stringify({
        success: true,
        tool: 'wiki_read',
      }),
    });
    const { lastFrame } = render(<UnmountToolBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('wiki_read');
  });

  it('shows failure state', () => {
    const state = makeState({
      name: 'mcp__demo__unmount_tool',
      result: JSON.stringify({
        success: false,
        error: 'Tool is not mounted.',
      }),
    });
    const { lastFrame } = render(<UnmountToolBlock state={state} />);
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('Tool is not mounted.');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'git__unmount_tool',
      status: 'error',
      result: 'Something went wrong',
    });
    const { lastFrame } = render(<UnmountToolBlock state={state} />);
    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('Something went wrong');
  });

  it('falls back to raw result when JSON is unparseable', () => {
    const state = makeState({
      name: 'git__unmount_tool',
      result: 'not json',
    });
    const { lastFrame } = render(<UnmountToolBlock state={state} />);
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('not json');
  });
});

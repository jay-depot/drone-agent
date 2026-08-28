/**
 * Tests for the SubagentDispatchBlock custom render component.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { SubagentDispatchBlock } from '../src/tui/components/SubagentDispatchBlock.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { ToolRenderState } from 'drone-core';

const scheme = DEFAULT_GRAYSCALE_SCHEME;

function makeState(overrides: Partial<ToolRenderState> = {}): ToolRenderState {
  return {
    name: 'subagent__dispatch',
    arguments: {},
    status: 'done',
    scheme: scheme as unknown,
    ...overrides,
  };
}

describe('SubagentDispatchBlock', () => {
  it('shows running state with task and persona', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Search the codebase for TODO comments',
        persona: 'explore',
      },
      status: 'running',
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    expect(frame).toContain('…');
    expect(frame).toContain('subagent__dispatch - explore');
    expect(frame).toContain('Search the codebase for TODO comments');
    expect(frame).toContain('─────────────────────────────────────');
  });

  it('shows running state with task and no persona', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Do something',
      },
      status: 'running',
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    expect(frame).toContain('…');
    expect(frame).toContain('subagent__dispatch');
    expect(frame).not.toContain('subagent__dispatch -');
  });

  it('shows reasoning as last action while running', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Analyze the code',
        persona: 'explore',
      },
      status: 'running',
      outputLines: ['reasoning:Looking for patterns in the codebase...'],
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    expect(frame).toContain('Looking for patterns in the codebase...');
  });

  it('shows tool call as last action while running', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Search the code',
        persona: 'explore',
      },
      status: 'running',
      outputLines: ['tool:search__text(pattern: "TODO")'],
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    expect(frame).toContain('⚡');
    expect(frame).toContain('search__text(pattern: "TODO")');
  });

  it('shows assistant message as last action while running', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Review the code',
        persona: 'review',
      },
      status: 'running',
      outputLines: ['msg:I found 3 issues in the codebase.'],
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    expect(frame).toContain('I found 3 issues in the codebase.');
  });

  it('shows done state with result rendered as markdown', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Find all exports',
        persona: 'explore',
      },
      status: 'done',
      result: JSON.stringify({
        result: 'Found **5 exports** in the codebase.',
        exitCode: 0,
      }),
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    expect(frame).toContain('✓');
    expect(frame).toContain('subagent__dispatch - explore');
    expect(frame).toContain('Find all exports');
    expect(frame).toContain('─────────────────────────────────────');
    expect(frame).toContain('Found');
    expect(frame).toContain('5 exports');
    expect(frame).toContain('in the codebase.');
  });

  it('shows done state with error result', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Do something',
      },
      status: 'done',
      result: JSON.stringify({
        error: 'Subagent timed out',
        timedOut: true,
        exitCode: null,
      }),
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    expect(frame).toContain('✓');
    expect(frame).toContain('Subagent timed out');
  });

  it('shows error state', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Do something dangerous',
      },
      status: 'error',
      result: 'subagent__dispatch failed: subagent crashed',
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    expect(frame).toContain('✗');
    expect(frame).toContain('subagent__dispatch');
    expect(frame).toContain('subagent crashed');
  });

  it('shows error state with fallback message when no result', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Do something',
      },
      status: 'error',
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    expect(frame).toContain('✗');
    expect(frame).toContain('Subagent failed');
  });

  it('shows last action as the most recent output line', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Search and analyze',
        persona: 'explore',
      },
      status: 'running',
      outputLines: [
        'reasoning:First, I will search for patterns...',
        'tool:search__text(pattern: "TODO")',
        'msg:Found 10 TODO comments. Now analyzing...',
      ],
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    // Should show the most recent (last) action
    expect(frame).toContain('Found 10 TODO comments. Now analyzing...');
    expect(frame).not.toContain('First, I will search for patterns...');
  });

  it('shows error as last action while running', () => {
    const state = makeState({
      name: 'subagent__dispatch',
      arguments: {
        task: 'Process data',
        persona: 'explore',
      },
      status: 'running',
      outputLines: ['error:LLM API quota exceeded'],
    });
    const { lastFrame } = render(<SubagentDispatchBlock state={state} />);
    const frame = lastFrame();
    expect(frame).toContain('✗');
    expect(frame).toContain('LLM API quota exceeded');
  });
});

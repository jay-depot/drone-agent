/**
 * @vitest-environment node
 *
 * Unit tests for the MCP prompt-fragment renderers. These are pure
 * functions, so no engine or disk is involved.
 */

import { describe, expect, it } from 'vitest';
import type { DroneMcpServerState } from 'drone-core';
import {
  renderServerSection,
  renderStatusSection,
  type McpServerSummary,
} from '../src/plugins/mcp/prompt-fragments.js';

function state(
  overrides: Partial<DroneMcpServerState> = {}
): DroneMcpServerState {
  return {
    id: 'demo',
    transport: 'stdio',
    ownership: 'spawned',
    status: 'connected',
    detail: 'fake-server',
    discoveredToolCount: 2,
    mountedToolCount: 0,
    filteredToolCount: 0,
    retryCount: 0,
    retryAttemptCount: 0,
    ...overrides,
  };
}

function summary(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    id: 'demo',
    state: state(),
    availableToolCount: 2,
    ...overrides,
  };
}

describe('renderServerSection', () => {
  it('returns false when there are no servers', () => {
    expect(renderServerSection([])).toBe(false);
  });

  it('renders the heading, the reminder, and a server line', () => {
    const rendered = renderServerSection([summary()]);
    expect(rendered).not.toBe(false);
    const text = rendered as string;
    expect(text).toContain('# MCP Servers');
    expect(text).toContain('- demo (2 tools)');
  });

  it('names runtime__list_tools in the reminder blurb', () => {
    const text = renderServerSection([summary()]) as string;
    expect(text).toContain('runtime__list_tools');
    expect(text).toContain('{"plugin":"mcp"}');
  });

  it('appends the description as prose when present', () => {
    const text = renderServerSection([
      summary({ description: 'Searches the web.' }),
    ]) as string;
    expect(text).toContain('- demo (2 tools): Searches the web.');
  });

  it('omits prose when no description is known', () => {
    const text = renderServerSection([summary()]) as string;
    expect(text).toContain('- demo (2 tools)');
    expect(text).not.toContain('- demo (2 tools):');
  });

  it('uses the singular form for exactly one available tool', () => {
    const text = renderServerSection([
      summary({ availableToolCount: 1 }),
    ]) as string;
    expect(text).toContain('- demo (1 tool)');
  });

  it('renders zero tools without prose', () => {
    const text = renderServerSection([
      summary({ availableToolCount: 0 }),
    ]) as string;
    expect(text).toContain('- demo (0 tools)');
  });

  it('lists every server it is given', () => {
    const text = renderServerSection([
      summary({ id: 'alpha', availableToolCount: 1 }),
      summary({ id: 'beta', availableToolCount: 3 }),
    ]) as string;
    expect(text).toContain('- alpha (1 tool)');
    expect(text).toContain('- beta (3 tools)');
  });
});

describe('renderStatusSection', () => {
  it('returns false when every server is connected', () => {
    expect(renderStatusSection([summary()])).toBe(false);
  });

  it('returns false when there are no servers', () => {
    expect(renderStatusSection([])).toBe(false);
  });

  it('renders only non-connected servers', () => {
    const text = renderStatusSection([
      summary({ id: 'ok', state: state({ id: 'ok' }) }),
      summary({
        id: 'broken',
        state: state({ id: 'broken', status: 'error' }),
      }),
    ]) as string;
    expect(text).toContain('- broken: error');
    expect(text).not.toContain('- ok:');
  });

  it('renders the lastError detail when present', () => {
    const text = renderStatusSection([
      summary({
        id: 'broken',
        state: state({
          id: 'broken',
          status: 'error',
          lastError: 'spawn ENOENT',
        }),
      }),
    ]) as string;
    expect(text).toContain('- broken: error — spawn ENOENT');
  });

  it('covers connecting and disconnected states', () => {
    const text = renderStatusSection([
      summary({ id: 'a', state: state({ id: 'a', status: 'connecting' }) }),
      summary({ id: 'b', state: state({ id: 'b', status: 'disconnected' }) }),
    ]) as string;
    expect(text).toContain('- a: connecting');
    expect(text).toContain('- b: disconnected');
  });
});

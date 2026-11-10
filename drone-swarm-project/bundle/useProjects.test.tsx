import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useProjects } from './useProjects';
import { setApi } from './api';

function installApi(projects: unknown[]) {
  setApi({
    registerComponent: () => () => {},
    registerRoute: () => () => {},
    fetch: vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, body: { projects } }),
    })) as unknown as typeof fetch,
    navigate: () => {},
    ui: {
      errors: {
        show: vi.fn(),
        fromResponse: vi.fn(async () => 'x'),
        fromThrown: vi.fn(() => 'x'),
      },
    },
  });
}

describe('useProjects', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('selects the first project after the load', async () => {
    installApi([
      { id: 'p_1', name: 'Alpha', cardCount: 1 },
      { id: 'p_2', name: 'Beta', cardCount: 0 },
    ]);
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(result.current.selected).toBe('p_1');
  });

  it('keeps the current selection across a reload', async () => {
    installApi([{ id: 'p_1', name: 'Alpha', cardCount: 1 }]);
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.selected).toBe('p_1'));
    act(() => result.current.setSelected('p_9'));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.selected).toBe('p_9');
  });
});

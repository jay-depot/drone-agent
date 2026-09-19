import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import type { ReactElement, ReactNode } from 'react';
import { useWikiFilterState } from './use-wiki-filter-state';

function wrapper(initialEntries: string[] = ['/']): {
  wrapper: (props: { children: ReactNode }) => ReactElement;
} {
  return {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    ),
  };
}

function useHarness() {
  return { state: useWikiFilterState(), params: useSearchParams()[0] };
}

describe('useWikiFilterState', () => {
  it('defaults with no params', () => {
    const { wrapper: W } = wrapper();
    const { result } = renderHook(() => useHarness(), { wrapper: W });
    expect(result.current.state.filters.tags).toEqual([]);
    expect(result.current.state.sort).toEqual({ key: null, dir: 'asc' });
  });

  it('reads filters and sort from the URL', () => {
    const { wrapper: W } = wrapper(['/?tags=ops,design&sort=words&dir=desc']);
    const { result } = renderHook(() => useHarness(), { wrapper: W });
    expect(result.current.state.filters.tags).toEqual(['ops', 'design']);
    expect(result.current.state.sort).toEqual({ key: 'words', dir: 'desc' });
  });

  it('writes filters to params and omits defaults', () => {
    const { wrapper: W } = wrapper();
    const { result } = renderHook(() => useHarness(), { wrapper: W });
    act(() => {
      result.current.state.setFilters({
        ...result.current.state.filters,
        tags: ['ops'],
        hasLinks: true,
      });
    });
    expect(result.current.params.get('tags')).toBe('ops');
    expect(result.current.params.get('links')).toBe('1');
    expect(result.current.params.get('srcs')).toBeNull();
  });

  it('resets offset when a filter changes', () => {
    const { wrapper: W } = wrapper(['/?offset=24']);
    const { result } = renderHook(() => useHarness(), { wrapper: W });
    act(() => {
      result.current.state.setFilters({
        ...result.current.state.filters,
        tags: ['ops'],
      });
    });
    expect(result.current.params.get('offset')).toBeNull();
  });

  it('toggles direction on repeat sort of the same column', () => {
    const { wrapper: W } = wrapper();
    const { result } = renderHook(() => useHarness(), { wrapper: W });
    act(() => result.current.state.setSort('title'));
    expect(result.current.params.get('dir')).toBe('asc');
    act(() => result.current.state.setSort('title'));
    expect(result.current.params.get('dir')).toBe('desc');
  });

  it('starts a new column at asc, except updated which starts desc', () => {
    const { wrapper: W } = wrapper();
    const { result } = renderHook(() => useHarness(), { wrapper: W });
    act(() => result.current.state.setSort('words'));
    expect(result.current.params.get('dir')).toBe('asc');
    act(() => result.current.state.setSort('updated'));
    expect(result.current.params.get('dir')).toBe('desc');
  });

  it('clears sort when set to null', () => {
    const { wrapper: W } = wrapper(['/?sort=words&dir=desc']);
    const { result } = renderHook(() => useHarness(), { wrapper: W });
    act(() => result.current.state.setSort(null));
    expect(result.current.params.get('sort')).toBeNull();
    expect(result.current.params.get('dir')).toBeNull();
  });

  it('clearFilters removes all filter params but keeps unrelated ones', () => {
    const { wrapper: W } = wrapper([
      '/?view=graph&node=a&tags=ops&links=1&dfrom=2026-01-01',
    ]);
    const { result } = renderHook(() => useHarness(), { wrapper: W });
    act(() => result.current.state.clearFilters());
    expect(result.current.params.get('tags')).toBeNull();
    expect(result.current.params.get('links')).toBeNull();
    expect(result.current.params.get('dfrom')).toBeNull();
    expect(result.current.params.get('view')).toBe('graph');
    expect(result.current.params.get('node')).toBe('a');
  });
});

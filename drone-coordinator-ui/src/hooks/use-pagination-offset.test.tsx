import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement, ReactNode } from 'react';
import { usePaginationOffset } from './use-pagination-offset';

function wrapper(initialEntries: string[] = ['/']): {
  wrapper: (props: { children: ReactNode }) => ReactElement;
} {
  return {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    ),
  };
}

describe('usePaginationOffset', () => {
  const PAGE_SIZE = 12;

  it('defaults to 0 when no offset param is present', () => {
    const { wrapper: W } = wrapper();
    const { result } = renderHook(() => usePaginationOffset(PAGE_SIZE), {
      wrapper: W,
    });
    expect(result.current.offset).toBe(0);
  });

  it('reads a valid offset from the URL', () => {
    const { wrapper: W } = wrapper(['/?offset=24']);
    const { result } = renderHook(() => usePaginationOffset(PAGE_SIZE), {
      wrapper: W,
    });
    expect(result.current.offset).toBe(24);
  });

  it('clamps a non-page-aligned offset down to a page boundary', () => {
    const { wrapper: W } = wrapper(['/?offset=25']);
    const { result } = renderHook(() => usePaginationOffset(PAGE_SIZE), {
      wrapper: W,
    });
    expect(result.current.offset).toBe(24);
  });

  it('falls back to 0 for a negative offset', () => {
    const { wrapper: W } = wrapper(['/?offset=-5']);
    const { result } = renderHook(() => usePaginationOffset(PAGE_SIZE), {
      wrapper: W,
    });
    expect(result.current.offset).toBe(0);
  });

  it('falls back to 0 for a non-numeric offset', () => {
    const { wrapper: W } = wrapper(['/?offset=abc']);
    const { result } = renderHook(() => usePaginationOffset(PAGE_SIZE), {
      wrapper: W,
    });
    expect(result.current.offset).toBe(0);
  });
});

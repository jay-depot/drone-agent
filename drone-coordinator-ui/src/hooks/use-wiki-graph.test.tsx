import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useWikiGraph } from './use-wiki-graph';

const fetchMock = vi.fn();
const subscribeHandlers = new Map<string, Set<(data: unknown) => void>>();

vi.mock('./use-auth', () => ({
  useAuthenticatedFetch: () => fetchMock,
}));

vi.mock('./use-websocket', () => ({
  useWebSocket: () => ({
    status: 'connected' as const,
    subscribe: (type: string, handler: (data: unknown) => void) => {
      if (!subscribeHandlers.has(type)) {
        subscribeHandlers.set(type, new Set());
      }
      subscribeHandlers.get(type)!.add(handler);
      return () => {
        subscribeHandlers.get(type)!.delete(handler);
      };
    },
    send: vi.fn(),
  }),
}));

function okGraph(pages = 1) {
  return new Response(
    JSON.stringify({
      nodes: Array.from({ length: pages }, (_, i) => ({
        id: `p${i}`,
        title: `P${i}`,
        exists: true,
        tags: [],
        scope: 'coordinator',
      })),
      edges: [],
    }),
    { status: 200 }
  );
}

function wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

describe('useWikiGraph live updates', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    subscribeHandlers.clear();
  });

  it('fetches the graph on mount when active', async () => {
    fetchMock.mockResolvedValue(okGraph());
    const { result } = renderHook(() => useWikiGraph(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches (debounced) when wiki.changed arrives over the socket', async () => {
    fetchMock.mockResolvedValue(okGraph());
    const { result } = renderHook(() => useWikiGraph(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const handlers = subscribeHandlers.get('wiki.changed');
    expect(handlers).toBeDefined();

    // Three events in a burst collapse into one fetch after the debounce.
    await act(async () => {
      for (const handler of handlers!) handler({});
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });

    // A later event (after the previous debounce window closed) triggers
    // exactly one more fetch.
    await new Promise(resolve => setTimeout(resolve, 600));
    await act(async () => {
      for (const handler of handlers!) handler({});
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), {
      timeout: 2000,
    });
  });

  it('does not subscribe when inactive', async () => {
    renderHook(() => useWikiGraph(false), { wrapper });
    expect(subscribeHandlers.has('wiki.changed')).toBe(false);
  });
});

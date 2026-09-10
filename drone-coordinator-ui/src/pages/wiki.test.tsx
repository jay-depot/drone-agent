import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import WikiPage from './wiki';
import { AuthProvider } from '@/hooks/use-auth';
import { ToastProvider } from '@/hooks/use-toast';
import { WebSocketProvider } from '@/hooks/use-websocket';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

function renderWiki() {
  return render(
    <ToastProvider>
      <AuthProvider>
        <WebSocketProvider>
          <MemoryRouter>
            <WikiPage />
          </MemoryRouter>
        </WebSocketProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

const metaPage = {
  id: 'deploy',
  title: 'Deployment',
  scope: 'coordinator',
  tags: ['ops'],
  sources: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('WikiPage search', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flattens { page, snippet, score } search results into page metadata', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki') {
        return {
          ok: true,
          status: 200,
          json: async () => [metaPage],
        } as Response;
      }
      if (url.startsWith('/api/wiki/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { page: metaPage, snippet: 'deploy with docker', score: 0.8 },
          ],
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderWiki();
    await screen.findByText('Deployment');

    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText('Search wiki pages...'),
      'deploy'
    );

    // The tags badge only renders after the { page, snippet, score } wrapper
    // is flattened (tags live under `.page.tags`, not top-level). Without the
    // flatten this render throws on `page.tags.length`.
    await waitFor(() => {
      expect(screen.getByText('ops')).toBeTruthy();
    });

    // The tag badge is a link to the tag page.
    const tagLink = screen.getByRole('link', { name: 'ops' });
    expect(tagLink).toHaveAttribute('href', '/wiki/tag/ops');
  });

  it('shows an error toast when the search request fails', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki') {
        return {
          ok: true,
          status: 200,
          json: async () => [metaPage],
        } as Response;
      }
      if (url.startsWith('/api/wiki/search')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'Search unavailable' }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderWiki();
    await screen.findByText('Deployment');

    const searchCalls = () =>
      mockFetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/wiki/search')
      ).length;

    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText('Search wiki pages...'),
      'deploy'
    );

    // Debounced: requests fire only once typing settles (SEARCH_DEBOUNCE_MS).
    await waitFor(
      () => {
        expect(searchCalls()).toBe(1);
      },
      { timeout: 2000 }
    );

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('Search unavailable');
  });
});

describe('WikiPage graph view', () => {
  const wikiGraphStub = vi.hoisted(() => ({
    props: null as Record<string, unknown> | null,
  }));

  const graph = {
    nodes: [
      {
        id: 'a',
        title: 'Page A',
        exists: true,
        wordCount: 42,
        tags: ['ops'],
        pitch: 'A one-liner about A.',
        scope: 'coordinator',
      },
      {
        id: 'b',
        title: 'Page B',
        exists: true,
        wordCount: 3,
        tags: [],
        scope: 'coordinator',
      },
    ],
    edges: [{ source: 'a', target: 'b', kind: 'link' }],
  };

  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
    wikiGraphStub.props = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the Graph toggle and renders the graph in ?view=graph', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki/graph') {
        return { ok: true, status: 200, json: async () => graph } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    // Stub the real graph (canvas-dependent) with a lightweight div.
    vi.mock('@/components/wiki-graph', () => ({
      default: (props: Record<string, unknown>) => {
        wikiGraphStub.props = props;
        return <div data-testid="wiki-graph-stub" />;
      },
    }));

    render(
      <ToastProvider>
        <AuthProvider>
          <WebSocketProvider>
            <MemoryRouter initialEntries={['/wiki?view=graph']}>
              <Routes>
                <Route path="/wiki" element={<WikiPage />} />
              </Routes>
            </MemoryRouter>
          </WebSocketProvider>
        </AuthProvider>
      </ToastProvider>
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/wiki/graph',
        expect.anything()
      );
    });
    expect(screen.getByTestId('wiki-graph-stub')).toBeDefined();
    // The toggle shows "Grid" (because we are in graph view).
    expect(screen.getByRole('button', { name: 'Grid' })).toBeDefined();
  });

  it('renders the Tags toggle and always includes orphan pages', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki/graph') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            nodes: [
              ...graph.nodes,
              {
                id: 'lonely',
                title: 'Lonely',
                exists: true,
                wordCount: 1,
                tags: ['misc'],
                scope: 'coordinator',
              },
            ],
            edges: graph.edges,
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    render(
      <ToastProvider>
        <AuthProvider>
          <WebSocketProvider>
            <MemoryRouter initialEntries={['/wiki?view=graph']}>
              <Routes>
                <Route path="/wiki" element={<WikiPage />} />
              </Routes>
            </MemoryRouter>
          </WebSocketProvider>
        </AuthProvider>
      </ToastProvider>
    );

    expect(screen.getByRole('button', { name: 'Tags' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Orphans' })).toBeNull();

    // Orphans are always part of the graph now; the tag layer alone docks them.
    const nodeIds = () =>
      ((wikiGraphStub.props?.nodes as Array<{ id: string }>) ?? []).map(
        n => n.id
      );
    await waitFor(() => {
      expect(nodeIds()).toContain('lonely');
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    await waitFor(() => {
      expect(wikiGraphStub.props?.tagsVisible).toBe(true);
    });
    await waitFor(() => {
      expect(nodeIds()).toContain('lonely');
    });
  });

  it('preserves the tags param across focus set and clear (stale-closure regression)', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki/graph') {
        return { ok: true, status: 200, json: async () => graph } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    // Tags enabled AFTER the graph view mounts — the same order that
    // previously dropped the param on canvas-initiated focus changes.
    render(
      <ToastProvider>
        <AuthProvider>
          <WebSocketProvider>
            <MemoryRouter initialEntries={['/wiki?view=graph']}>
              <Routes>
                <Route path="/wiki" element={<WikiPage />} />
              </Routes>
            </MemoryRouter>
          </WebSocketProvider>
        </AuthProvider>
      </ToastProvider>
    );
    const user = userEvent.setup();
    await waitFor(() => {
      expect(wikiGraphStub.props).not.toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    await waitFor(() => {
      expect(wikiGraphStub.props?.tagsVisible).toBe(true);
    });

    // Focus from the canvas path (stub relays onNodeFocus), then clear.
    act(() => {
      (wikiGraphStub.props?.onNodeFocus as (id: string) => void)('a');
    });
    // The page preserves the tags param: the stub sees tagsVisible stay true
    // and the focused node appear. (MemoryRouter doesn't touch
    // window.location, so the URL is asserted via the stub's props.)
    await waitFor(() => {
      expect(wikiGraphStub.props?.focusedNodeId).toBe('a');
      expect(wikiGraphStub.props?.tagsVisible).toBe(true);
    });

    act(() => {
      (wikiGraphStub.props?.onClearFocus as () => void)();
    });
    await waitFor(() => {
      expect(wikiGraphStub.props?.focusedNodeId).toBeNull();
      // Regression: the stale closure rebuilt the URL from a first-render
      // snapshot without tags=1, so tagsVisible flipped to false on clear.
      expect(wikiGraphStub.props?.tagsVisible).toBe(true);
    });
  });

  it('passes tag nodes to the graph when Tags is on', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki/graph') {
        return { ok: true, status: 200, json: async () => graph } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    render(
      <ToastProvider>
        <AuthProvider>
          <WebSocketProvider>
            <MemoryRouter initialEntries={['/wiki?view=graph&tags=1']}>
              <Routes>
                <Route path="/wiki" element={<WikiPage />} />
              </Routes>
            </MemoryRouter>
          </WebSocketProvider>
        </AuthProvider>
      </ToastProvider>
    );

    await waitFor(() => {
      expect(wikiGraphStub.props).not.toBeNull();
    });
    expect(wikiGraphStub.props?.tagsVisible).toBe(true);
    const nodeIds = (wikiGraphStub.props?.nodes as Array<{ id: string }>).map(
      n => n.id
    );
    expect(nodeIds).toContain('tag:ops');
  });

  it('shows a tag-aware preview panel without an open-page button for tag focus', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki/graph') {
        return { ok: true, status: 200, json: async () => graph } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    render(
      <ToastProvider>
        <AuthProvider>
          <WebSocketProvider>
            <MemoryRouter
              initialEntries={['/wiki?view=graph&tags=1&node=tag:ops']}
            >
              <Routes>
                <Route path="/wiki" element={<WikiPage />} />
              </Routes>
            </MemoryRouter>
          </WebSocketProvider>
        </AuthProvider>
      </ToastProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Tag · 1 page(s)')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: 'Open full page' })).toBeNull();
    // Member pages are no longer listed on tag panels (they're all
    // highlighted on the canvas anyway).
    expect(screen.queryByText('Page A')).toBeNull();
  });

  it('does not fetch the graph in the default grid view', async () => {
    const mockFetch = vi.fn<
      (url: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => [],
        }) as Response
    );
    vi.stubGlobal('fetch', mockFetch);

    renderWiki();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search wiki pages...')).toBeDefined();
    });
    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes('/wiki/graph'))
    ).toBe(false);
  });
});

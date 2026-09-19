import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/hooks/use-auth';
import { ToastProvider } from '@/hooks/use-toast';
import { WebSocketProvider } from '@/hooks/use-websocket';
import WikiPage from './wiki';

// The graph is canvas-dependent; stub it file-wide and record its props so
// tests can assert on what the page handed it. Must be hoisted to module
// scope — a vi.mock inside a test body is not allowed by vitest.
const wikiGraphStub = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

vi.mock('@/components/wiki-graph', () => ({
  default: (props: Record<string, unknown>) => {
    wikiGraphStub.props = props;
    return <div data-testid="wiki-graph-stub" />;
  },
}));

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

function renderWiki(initialEntries: string[] = ['/wiki']) {
  return render(
    <ToastProvider>
      <AuthProvider>
        <WebSocketProvider>
          <MemoryRouter initialEntries={initialEntries}>
            <WikiPage />
          </MemoryRouter>
        </WebSocketProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

function metaPage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deploy',
    title: 'Deployment',
    scope: 'coordinator',
    tags: ['ops'],
    sources: [],
    wordCount: 42,
    linkCount: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const notFound = {
  ok: false,
  status: 404,
  json: async () => ({}),
} as Response;

describe('WikiPage list view', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the six-column table with the expected headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/wiki' ? ok([metaPage()]) : notFound
      )
    );

    renderWiki();
    await screen.findByText('Deployment');

    for (const header of [
      'Title',
      'Tags',
      'Created',
      'Updated',
      'Word Count',
      'Source Sessions',
    ]) {
      expect(screen.getByRole('columnheader', { name: new RegExp(header) }));
    }
    expect(screen.getByRole('cell', { name: '42' })).toBeTruthy();
  });

  it('flattens { page, snippet, score } search results into page metadata', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki') return ok([metaPage()]);
      if (url.startsWith('/api/wiki/search')) {
        return ok([
          { page: metaPage(), snippet: 'deploy with docker', score: 0.8 },
        ]);
      }
      return notFound;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderWiki();
    await screen.findByText('Deployment');

    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText('Search wiki pages...'),
      'deploy'
    );

    // The tag badge only renders after the { page, snippet, score } wrapper
    // is flattened (tags live under `.page.tags`, not top-level).
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'ops' })).toHaveAttribute(
        'href',
        '/wiki/tag/ops'
      );
    });
  });

  it('shows an error toast when the search request fails', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki') return ok([metaPage()]);
      if (url.startsWith('/api/wiki/search')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'Search unavailable' }),
        } as Response;
      }
      return notFound;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderWiki();
    await screen.findByText('Deployment');

    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText('Search wiki pages...'),
      'deploy'
    );

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('Search unavailable');
  });

  it('composes keyword search with active filters (AND)', async () => {
    const opsPage = metaPage({ id: 'ops-page', title: 'Ops Page' });
    const designPage = metaPage({
      id: 'design-page',
      title: 'Design Page',
      tags: ['design'],
    });
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki') return ok([opsPage, designPage]);
      // Search returns BOTH pages; the tag filter should drop the design one.
      if (url.startsWith('/api/wiki/search')) {
        return ok([
          { page: opsPage, snippet: 's', score: 0.9 },
          { page: designPage, snippet: 's', score: 0.8 },
        ]);
      }
      return notFound;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderWiki(['/wiki?tags=ops']);
    await screen.findByText('Ops Page');

    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText('Search wiki pages...'),
      'page'
    );

    await waitFor(() => {
      expect(screen.getByText('Ops Page')).toBeTruthy();
    });
    // The design page has no 'ops' tag, so the active filter excludes it.
    expect(screen.queryByText('Design Page')).toBeNull();
  });

  it('restores the full list when the search box is cleared (bugfix)', async () => {
    const opsPage = metaPage({ id: 'ops-page', title: 'Ops Page' });
    const otherPage = metaPage({ id: 'other-page', title: 'Other Page' });
    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/api/wiki') return ok([opsPage, otherPage]);
      if (url.startsWith('/api/wiki/search')) {
        // Only the ops page matches the query.
        return ok([{ page: opsPage, snippet: 's', score: 0.9 }]);
      }
      return notFound;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderWiki();
    await screen.findByText('Other Page');

    const user = userEvent.setup();
    const searchBox = screen.getByPlaceholderText('Search wiki pages...');
    await user.type(searchBox, 'ops');
    await waitFor(() => {
      expect(screen.queryByText('Other Page')).toBeNull();
    });

    // Clearing must restore the full list, not leave the stale search results.
    await user.clear(searchBox);
    await waitFor(() => {
      expect(screen.getByText('Other Page')).toBeTruthy();
    });
  });
});

describe('WikiPage graph view', () => {
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

  const graphFetch = (
    pages: unknown[] = [metaPage({ id: 'a', tags: ['ops'] })]
  ) =>
    vi.fn(async (url: string) => {
      if (url === '/api/wiki/graph') return ok(graph);
      if (url === '/api/wiki') return ok(pages);
      return notFound;
    });

  it('renders the graph in ?view=graph and toggles back to the list', async () => {
    vi.stubGlobal('fetch', graphFetch());

    renderWiki(['/wiki?view=graph']);
    await screen.findByTestId('wiki-graph-stub');

    // In graph view the toggle offers the list.
    expect(screen.getByRole('button', { name: 'List' })).toBeTruthy();
  });

  it('reports tag-node visibility from ?tagnodes=1', async () => {
    vi.stubGlobal('fetch', graphFetch());

    renderWiki(['/wiki?view=graph&tagnodes=1']);
    await waitFor(() => {
      expect(wikiGraphStub.props?.tagsVisible).toBe(true);
    });
  });

  it('passes no filter set when no filters are active', async () => {
    vi.stubGlobal('fetch', graphFetch());

    renderWiki(['/wiki?view=graph']);
    await waitFor(() => {
      expect(wikiGraphStub.props).not.toBeNull();
    });
    expect(wikiGraphStub.props?.filterActiveIds).toBeNull();
  });

  it('passes the filter-active id set (page ids + selected tag ids)', async () => {
    vi.stubGlobal('fetch', graphFetch());

    renderWiki(['/wiki?view=graph&tags=ops']);
    await waitFor(() => {
      expect(wikiGraphStub.props?.filterActiveIds).toBeInstanceOf(Set);
    });
    const ids = wikiGraphStub.props?.filterActiveIds as Set<string>;
    expect(ids.has('a')).toBe(true);
    expect(ids.has('tag:ops')).toBe(true);
  });

  it('preserves filter params across focus set and clear', async () => {
    vi.stubGlobal('fetch', graphFetch());

    renderWiki(['/wiki?view=graph&tags=ops']);
    await waitFor(() => {
      expect(wikiGraphStub.props).not.toBeNull();
    });

    act(() => {
      (wikiGraphStub.props?.onNodeFocus as (id: string) => void)('a');
    });
    await waitFor(() => {
      expect(wikiGraphStub.props?.focusedNodeId).toBe('a');
    });
    // The tag filter survives focus changes (regression: URL rebuilt from a
    // stale snapshot dropped the param).
    const afterFocus = wikiGraphStub.props?.filterActiveIds as Set<string>;
    expect(afterFocus.has('tag:ops')).toBe(true);

    act(() => {
      (wikiGraphStub.props?.onClearFocus as () => void)();
    });
    await waitFor(() => {
      expect(wikiGraphStub.props?.focusedNodeId).toBeNull();
    });
    const afterClear = wikiGraphStub.props?.filterActiveIds as Set<string>;
    expect(afterClear.has('tag:ops')).toBe(true);
  });

  it('shows a tag-aware preview panel without an open-page button for tag focus', async () => {
    vi.stubGlobal('fetch', graphFetch());

    renderWiki(['/wiki?view=graph&tagnodes=1&node=tag:ops']);

    await waitFor(() => {
      expect(screen.getByText('Tag · 1 page(s)')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Open full page' })).toBeNull();
    expect(screen.queryByText('Page A')).toBeNull();
  });

  it('does not fetch the graph in the default list view', async () => {
    const mockFetch = vi.fn(async (_url: string) => ok([]));
    vi.stubGlobal('fetch', mockFetch);

    renderWiki();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search wiki pages...')).toBeTruthy();
    });
    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes('/wiki/graph'))
    ).toBe(false);
  });
});

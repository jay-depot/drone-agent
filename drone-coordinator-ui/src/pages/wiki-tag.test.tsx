import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import WikiTagPage from './wiki-tag';
import { AuthProvider } from '@/hooks/use-auth';

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

function renderTagPage(tag: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[`/wiki/tag/${tag}`]}>
        <Routes>
          <Route path="/wiki/tag/:tag" element={<WikiTagPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

function taggedPage(id: string, title: string, tags: string[]) {
  return {
    id,
    title,
    scope: 'coordinator',
    tags,
    sources: [],
    wordCount: 10,
    linkCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const opsPages = [
  taggedPage('deploy', 'Deployment', ['ops']),
  taggedPage('arch', 'Architecture', ['ops', 'design']),
];

describe('WikiTagPage', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches /api/wiki?tag=<tag> and renders the returned pages in a table', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      expect(url).toBe('/api/wiki?tag=ops');
      return { ok: true, status: 200, json: async () => opsPages } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderTagPage('ops');

    await screen.findByText('Deployment');
    expect(screen.getByText('Architecture')).toBeTruthy();
    expect(screen.getByText(/2 pages tagged with "ops"/)).toBeTruthy();
    expect(
      screen.getByRole('columnheader', { name: /Word Count/ })
    ).toBeTruthy();
  });

  it('has no filter bar or search box', async () => {
    const mockFetch = vi.fn(async () => {
      return { ok: true, status: 200, json: async () => opsPages } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderTagPage('ops');
    await screen.findByText('Deployment');

    expect(screen.queryByPlaceholderText('Search wiki pages...')).toBeNull();
    expect(screen.queryByLabelText('Filter by tags')).toBeNull();
  });

  it('shows an empty state when the server returns no pages', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      expect(url).toBe('/api/wiki?tag=nonexistent');
      return { ok: true, status: 200, json: async () => [] } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderTagPage('nonexistent');

    await waitFor(() => {
      expect(
        screen.getByText('No wiki pages tagged with "nonexistent"')
      ).toBeTruthy();
    });
  });

  it('paginates when there are more than PAGE_SIZE (25) tagged pages', async () => {
    const manyPages = Array.from({ length: 30 }, (_, i) =>
      taggedPage(`page-${i}`, `Page ${i}`, ['ops'])
    );
    const mockFetch = vi.fn(async (url: string) => {
      expect(url).toBe('/api/wiki?tag=ops');
      return { ok: true, status: 200, json: async () => manyPages } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderTagPage('ops');

    await screen.findByText('Page 0');
    expect(screen.getByText('Page 24')).toBeTruthy();
    expect(screen.queryByText('Page 25')).toBeNull();
    expect(screen.getByText(/1-25 of 30/)).toBeTruthy();
  });
});

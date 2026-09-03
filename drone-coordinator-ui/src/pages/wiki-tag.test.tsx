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

const pages = [
  {
    id: 'deploy',
    title: 'Deployment',
    scope: 'coordinator',
    tags: ['ops'],
    sources: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'arch',
    title: 'Architecture',
    scope: 'coordinator',
    tags: ['ops', 'design'],
    sources: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'notes',
    title: 'Notes',
    scope: 'coordinator',
    tags: ['personal'],
    sources: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
];

describe('WikiTagPage', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters pages by the tag and shows the count', async () => {
    const mockFetch = vi.fn(async () => {
      return { ok: true, status: 200, json: async () => pages } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderTagPage('ops');

    await screen.findByText('Deployment');
    expect(screen.getByText('Architecture')).toBeTruthy();
    expect(screen.queryByText('Notes')).toBeNull();
    expect(screen.getByText(/2 pages tagged with "ops"/)).toBeTruthy();
  });

  it('shows an empty state when no pages have the tag', async () => {
    const mockFetch = vi.fn(async () => {
      return { ok: true, status: 200, json: async () => pages } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderTagPage('nonexistent');

    await waitFor(() => {
      expect(
        screen.getByText('No wiki pages tagged with "nonexistent"')
      ).toBeTruthy();
    });
  });

  it('paginates when there are more than PAGE_SIZE tagged pages', async () => {
    const manyPages = Array.from({ length: 15 }, (_, i) => ({
      id: `page-${i}`,
      title: `Page ${i}`,
      scope: 'coordinator',
      tags: ['ops'],
      sources: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }));
    const mockFetch = vi.fn(async () => {
      return { ok: true, status: 200, json: async () => manyPages } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderTagPage('ops');

    await screen.findByText('Page 0');
    expect(screen.getByText('Page 11')).toBeTruthy();
    expect(screen.queryByText('Page 12')).toBeNull();
    expect(screen.getByText(/1-12 of 15/)).toBeTruthy();
  });
});

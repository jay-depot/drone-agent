import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import WikiPage from './wiki';
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

function renderWiki() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <WikiPage />
      </MemoryRouter>
    </AuthProvider>
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
    await user.type(screen.getByPlaceholderText('Search wiki pages...'), 'deploy');

    // The tags badge only renders after the { page, snippet, score } wrapper
    // is flattened (tags live under `.page.tags`, not top-level). Without the
    // flatten this render throws on `page.tags.length`.
    await waitFor(() => {
      expect(screen.getByText('ops')).toBeTruthy();
    });
  });
});

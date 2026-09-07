import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import WikiDetailPage from './wiki-detail';
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

function renderDetail(initialPath = '/wiki/deploy') {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/wiki/:pageId" element={<WikiDetailPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

const pageWithPitch = {
  id: 'deploy',
  title: 'Deployment',
  scope: 'coordinator',
  tags: ['ops'],
  sources: [],
  pitch: 'A one-sentence pitch about deployment.',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  content: '# Deployment',
};

const pageWithoutPitch = {
  ...pageWithPitch,
  id: 'plain',
  title: 'Plain',
  pitch: undefined,
};

describe('WikiDetailPage pitch display', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the pitch in the info card when present', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => pageWithPitch,
      } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('Pitch')).toBeTruthy();
    });
    expect(
      screen.getByText('A one-sentence pitch about deployment.')
    ).toBeTruthy();
  });

  it('does not render a pitch row when the page has none', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => pageWithoutPitch,
      } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderDetail('/wiki/plain');

    await waitFor(() => {
      expect(screen.getByText('Plain')).toBeTruthy();
    });
    expect(screen.queryByText('Pitch')).toBeNull();
  });
});

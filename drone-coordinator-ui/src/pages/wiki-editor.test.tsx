import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import WikiEditorPage from './wiki-editor';
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

function renderEditor(initialPath: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/wiki/:pageId/edit" element={<WikiEditorPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

const existingPage = {
  id: 'deploy',
  title: 'Deployment',
  scope: 'coordinator',
  tags: ['ops'],
  sources: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  content: '# Deployment',
};

describe('WikiEditorPage create mode', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('?create=1 shows the page-ID field pre-filled and does not fetch', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => existingPage,
      } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderEditor('/wiki/deploy/edit?create=1');

    // Page-ID field is visible and pre-filled from the URL param
    const idInput = screen.getByLabelText('Page ID') as HTMLInputElement;
    expect(idInput.value).toBe('deploy');

    // No fetch should have happened (create mode skips loading the page)
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('normal edit mode still fetches the page', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => existingPage,
      } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderEditor('/wiki/deploy/edit');

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/wiki/deploy',
        expect.anything()
      );
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Title/)).toHaveValue('Deployment');
    });
  });
});

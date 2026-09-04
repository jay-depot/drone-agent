import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('WikiEditorPage back buttons', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('← Back pops browser history instead of navigating forward to the item', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => existingPage,
      } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    const WikiStub = () => <h1>Wiki List</h1>;
    const WikiDetailStub = () => <h1>Wiki Detail</h1>;

    // History stack: /wiki first, then /wiki/deploy/edit. Navigating back (-1)
    // should land on the /wiki list page, NOT forward to /wiki/deploy detail.
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/wiki', '/wiki/deploy/edit']}>
          <Routes>
            <Route path="/wiki" element={<WikiStub />} />
            <Route path="/wiki/:pageId" element={<WikiDetailStub />} />
            <Route path="/wiki/:pageId/edit" element={<WikiEditorPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Title/)).toHaveValue('Deployment');
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /← Back/ }));

    // navigate(-1) pops to the /wiki list. (Old forward-nav would have landed
    // on /wiki/deploy, so "Wiki List" would not be visible.)
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Wiki List' })
      ).toBeInTheDocument();
    });
  });
});

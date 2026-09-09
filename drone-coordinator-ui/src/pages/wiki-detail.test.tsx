import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import WikiDetailPage from './wiki-detail';
import { AuthProvider } from '@/hooks/use-auth';
import { ToastProvider } from '@/hooks/use-toast';

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
    <ToastProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/wiki/:pageId" element={<WikiDetailPage />} />
            <Route path="/wiki" element={<div>Wiki list</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ToastProvider>
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

describe('WikiDetailPage delete error handling', () => {
  function jsonResponse(status: number, body: unknown): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as Response;
  }

  function stubFetch(deleteResponse: Response) {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/wiki/deploy' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, pageWithPitch);
      }
      if (url === '/api/wiki/deploy' && init?.method === 'DELETE') {
        return deleteResponse;
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  async function confirmDelete() {
    renderDetail();
    await screen.findByRole('button', { name: 'Delete' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Delete' })
    );
  }

  it('shows an error toast and stays on the page when delete fails', async () => {
    stubFetch(jsonResponse(409, { error: 'Wiki page is in use' }));

    await confirmDelete();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Wiki page is in use');
    expect(screen.getByText('Pitch')).toBeInTheDocument();
  });

  it('shows a generic fallback toast when the error body has no message', async () => {
    stubFetch(jsonResponse(500, {}));

    await confirmDelete();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP 500: Unknown error');
  });

  it('navigates to the wiki list when delete succeeds', async () => {
    stubFetch(jsonResponse(200, {}));

    await confirmDelete();

    await waitFor(() => {
      expect(screen.getByText('Wiki list')).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

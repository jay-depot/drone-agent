import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import SkillDetailPage from './skill-detail';
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function renderDetail() {
  return render(
    <ToastProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={['/skills/deploy-skill']}>
          <Routes>
            <Route path="/skills/:id" element={<SkillDetailPage />} />
            <Route path="/skills" element={<div>Skills list</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ToastProvider>
  );
}

const skill = {
  id: 'deploy-skill',
  name: 'Deploy',
  description: 'Deploy the stack',
  trigger: 'deploy',
  body: 'run deploy',
  scope: 'user',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

describe('SkillDetailPage delete error handling', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(deleteResponse: Response) {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url === '/api/skills/deploy-skill' &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse(200, skill);
      }
      if (url === '/api/skills/deploy-skill' && init?.method === 'DELETE') {
        return deleteResponse;
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  async function confirmDelete() {
    renderDetail();
    await screen.findByText('Deploy');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Delete' })
    );
  }

  it('shows an error toast and stays on the page when delete fails', async () => {
    stubFetch(jsonResponse(409, { error: 'Skill is in use' }));

    await confirmDelete();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Skill is in use');
    expect(screen.getByText('Deploy')).toBeInTheDocument();
  });

  it('shows a generic fallback toast when the error body has no message', async () => {
    stubFetch(jsonResponse(500, {}));

    await confirmDelete();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP 500: Unknown error');
  });

  it('navigates to the skills list when delete succeeds', async () => {
    stubFetch(jsonResponse(200, {}));

    await confirmDelete();

    await waitFor(() => {
      expect(screen.getByText('Skills list')).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

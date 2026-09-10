import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SkillsPage from './skills';
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

function renderSkills() {
  return render(
    <ToastProvider>
      <AuthProvider>
        <MemoryRouter>
          <SkillsPage />
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

describe('SkillsPage delete error handling', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(deleteResponse: Response) {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/skills' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, [skill]);
      }
      if (url === '/api/skills/deploy-skill' && init?.method === 'DELETE') {
        return deleteResponse;
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  async function openDeleteDialog() {
    renderSkills();
    await screen.findByText('Deploy');
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    const dialog = await screen.findByRole('dialog');
    return {
      dialogConfirm: within(dialog).getByRole('button', { name: 'Delete' }),
    };
  }

  it('shows an error toast and keeps the row when delete fails', async () => {
    stubFetch(jsonResponse(409, { error: 'Skill is in use' }));
    const { dialogConfirm } = await openDeleteDialog();

    await userEvent.click(dialogConfirm);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Skill is in use');
    await waitFor(() => {
      expect(screen.getByText('Deploy')).toBeInTheDocument();
    });
  });

  it('falls back to a generic message when the error body has no message', async () => {
    stubFetch(jsonResponse(500, {}));
    const { dialogConfirm } = await openDeleteDialog();

    await userEvent.click(dialogConfirm);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP 500: Unknown error');
  });

  it('removes the row when delete succeeds', async () => {
    stubFetch(jsonResponse(200, {}));
    const { dialogConfirm } = await openDeleteDialog();

    await userEvent.click(dialogConfirm);

    await waitFor(() => {
      expect(screen.queryByText('Deploy')).toBeNull();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

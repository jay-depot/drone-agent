import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StoredSecretsModal from './stored-secrets-modal';
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

function renderModal() {
  return render(
    <ToastProvider>
      <AuthProvider>
        <StoredSecretsModal open onClose={() => {}} />
      </AuthProvider>
    </ToastProvider>
  );
}

/** Grab the last (innermost) open dialog — the outer modal + an inner form/confirm coexist. */
async function findFormDialog(): Promise<HTMLElement> {
  const dialogs = await screen.findAllByRole('dialog');
  return dialogs[dialogs.length - 1];
}

let mockFetch: ReturnType<typeof vi.fn>;

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response
): void {
  mockFetch = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', mockFetch);
}

const secretsResponse = [
  {
    name: 'OPENROUTER_API_KEY',
    maskedValue: '••••1234',
    updatedAt: 1_700_000_000_000,
    referencedBy: ['providers.openai'],
  },
  {
    name: 'UNUSED',
    maskedValue: '••••5678',
    updatedAt: 1_700_000_000_000,
    referencedBy: [],
  },
];

describe('StoredSecretsModal', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists secrets with masked values and referenced-by badges', async () => {
    stubFetch(url => {
      if (url === '/api/secrets' && 'GET') return jsonResponse(200, secretsResponse);
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderModal();
    await screen.findByText('OPENROUTER_API_KEY');
    expect(screen.getByText('••••1234')).toBeInTheDocument();
    expect(screen.queryByText('secret-raw-value-1234')).toBeNull();
    expect(screen.getByText('1 setting')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('add secret PUTs the new name/value', async () => {
    stubFetch(url => {
      if (url === '/api/secrets') return jsonResponse(200, []);
      if (url === '/api/secrets/NEW_KEY' && 'PUT') return jsonResponse(200, {});
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderModal();
    await screen.findByText(/No stored secrets yet/);
    await userEvent.click(screen.getByRole('button', { name: 'Add Secret' }));

    const form = await findFormDialog();
    await userEvent.type(
      within(form).getByPlaceholderText('OPENROUTER_API_KEY'),
      'NEW_KEY'
    );
    await userEvent.type(
      within(form).getByPlaceholderText('sk-…'),
      'sk-abc-1234'
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/secrets/NEW_KEY',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ value: 'sk-abc-1234' }),
        })
      );
    });
  });

  it('rotate with empty value omits value to keep current', async () => {
    stubFetch(url => {
      if (url === '/api/secrets') return jsonResponse(200, secretsResponse);
      if (url === '/api/secrets/OPENROUTER_API_KEY' && 'PUT')
        return jsonResponse(200, {});
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderModal();
    await screen.findByText('OPENROUTER_API_KEY');
    await userEvent.click(screen.getAllByRole('button', { name: 'Rotate' })[0]);

    const form = await findFormDialog();
    expect(
      within(form).getByText('Leave the value empty to keep the current secret unchanged.')
    ).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const put = mockFetch.mock.calls.find(
        call =>
          call[0] === '/api/secrets/OPENROUTER_API_KEY' &&
          (call[1] as RequestInit | undefined)?.method === 'PUT'
      );
      expect(put).toBeDefined();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body).not.toHaveProperty('value');
    });
  });

  it('delete shows referencing keys in the confirm, then DELETEs', async () => {
    const confirmCopy = 'providers.openai';
    stubFetch(url => {
      if (url === '/api/secrets') return jsonResponse(200, secretsResponse);
      if (url === '/api/secrets/OPENROUTER_API_KEY' && 'DELETE')
        return jsonResponse(200, { success: true });
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderModal();
    await screen.findByText('OPENROUTER_API_KEY');
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete' })[0]
    );

    const confirm = await findFormDialog();
    expect(confirm).toHaveTextContent(confirmCopy);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/secrets/OPENROUTER_API_KEY',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  it('shows a toast when add fails', async () => {
    stubFetch(url => {
      if (url === '/api/secrets') return jsonResponse(200, []);
      if (url === '/api/secrets/NEW_KEY' && 'PUT')
        return jsonResponse(400, { error: 'Invalid secret name' });
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderModal();
    await screen.findByText(/No stored secrets yet/);
    await userEvent.click(screen.getByRole('button', { name: 'Add Secret' }));

    const form = await findFormDialog();
    await userEvent.type(
      within(form).getByPlaceholderText('OPENROUTER_API_KEY'),
      'NEW_KEY'
    );
    fireEvent.change(within(form).getByPlaceholderText('sk-…'), {
      target: { value: 'sk-x' },
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid secret name');
  });
});

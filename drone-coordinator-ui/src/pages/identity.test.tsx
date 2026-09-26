import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import IdentityPage from './identity';
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

function renderIdentity() {
  return render(
    <ToastProvider>
      <AuthProvider>
        <MemoryRouter>
          <IdentityPage />
        </MemoryRouter>
      </AuthProvider>
    </ToastProvider>
  );
}

const identityFragment = {
  id: 'swarm-identity',
  target: 'broadcast',
  content: 'We are the test swarm.',
  phase: 'header' as const,
  scope: 'coordinator' as const,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: null,
};

describe('IdentityPage', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) =>
      handler(url, init)
    );
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  it('prefills the textarea from an existing identity row', async () => {
    stubFetch((url, init) => {
      if (
        url === '/api/fragments?target=broadcast' &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse(200, { fragments: [identityFragment] });
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderIdentity();
    const textarea = await screen.findByPlaceholderText(/Describe this swarm/);
    await waitFor(() => {
      expect(textarea).toHaveValue('We are the test swarm.');
    });
  });

  it('disables Save when there is no change', async () => {
    stubFetch(() => jsonResponse(200, { fragments: [identityFragment] }));

    renderIdentity();
    await screen.findByPlaceholderText(/Describe this swarm/);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  it('saves via PUT with the broadcast identity body', async () => {
    const mockFetch = stubFetch((url, init) => {
      if (
        url === '/api/fragments?target=broadcast' &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse(200, { fragments: [] });
      }
      if (url === '/api/fragments/swarm-identity' && init?.method === 'PUT') {
        return jsonResponse(200, { ok: true, fragment: identityFragment });
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderIdentity();
    const textarea = await screen.findByPlaceholderText(/Describe this swarm/);
    await userEvent.type(textarea, 'New identity text');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        call =>
          call[0] === '/api/fragments/swarm-identity' &&
          (call[1] as RequestInit | undefined)?.method === 'PUT'
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(
        String((putCall?.[1] as RequestInit).body)
      ) as Record<string, unknown>;
      expect(body).toMatchObject({
        target: 'broadcast',
        content: 'New identity text',
        phase: 'header',
      });
    });
  });

  it('clears via DELETE with the broadcast target', async () => {
    const mockFetch = stubFetch((url, init) => {
      if (
        url === '/api/fragments?target=broadcast' &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse(200, { fragments: [identityFragment] });
      }
      if (
        url === '/api/fragments/swarm-identity?target=broadcast' &&
        init?.method === 'DELETE'
      ) {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderIdentity();
    await screen.findByDisplayValue('We are the test swarm.');
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Clear' })
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/fragments/swarm-identity?target=broadcast',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  it('surfaces a load error via the error banner', async () => {
    stubFetch(() => jsonResponse(500, { error: 'Coordinator unavailable' }));

    renderIdentity();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Coordinator unavailable');
  });

  it('shows an over-limit byte counter and disables Save', async () => {
    stubFetch(() => jsonResponse(200, { fragments: [] }));

    renderIdentity();
    const textarea = await screen.findByPlaceholderText(/Describe this swarm/);
    // 16 KB cap + 1 byte.
    await userEvent.click(textarea);
    const huge = 'x'.repeat(16 * 1024 + 1);
    await userEvent.paste(huge);

    await waitFor(() => {
      expect(screen.getByText(/\/ 16384 bytes/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ConfigPage from './config';
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

function renderConfig() {
  return render(
    <ToastProvider>
      <AuthProvider>
        <MemoryRouter>
          <ConfigPage />
        </MemoryRouter>
      </AuthProvider>
    </ToastProvider>
  );
}

const secretEntry = {
  key: 'providers.openai',
  value: '••••abcd',
  secret: true,
  description: 'OpenAI provider',
  updatedAt: 1_700_000_000_000,
};

const plainEntry = {
  key: 'llm.active',
  value: 'openai/gpt-5.3-codex',
  secret: false,
  description: null,
  updatedAt: 1_700_000_000_000,
};

describe('ConfigPage', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(extra?: (url: string, init?: RequestInit) => Response) {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (extra) {
        const response = extra(url, init);
        if (response) return response;
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  it('lists config entries and masks secret values', async () => {
    stubFetch((url, init) => {
      if (url === '/api/config' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, [secretEntry, plainEntry]);
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderConfig();
    await screen.findByText('providers.openai');
    expect(screen.getByText('llm.active')).toBeInTheDocument();
    // Secret value is masked on read.
    expect(screen.getByText('••••abcd')).toBeInTheDocument();
    expect(screen.queryByText('sk-abc')).toBeNull();
    // Secret badge shown for secret entries.
    expect(screen.getByText('secret')).toBeInTheDocument();
  });

  it('add dialog PUTs a new config entry', async () => {
    const mockFetch = stubFetch((url, init) => {
      if (url === '/api/config' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, []);
      }
      if (url === '/api/config/providers.openai' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<
          string,
          unknown
        >;
        expect(body.secret).toBe(true);
        expect(body.value).toBe(JSON.stringify({ apiKey: 'sk-test' }));
        return jsonResponse(200, { ...secretEntry, value: '••••test' });
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderConfig();
    await screen.findByText('No config entries');
    await userEvent.click(screen.getByRole('button', { name: 'Add Config' }));

    const dialog = await screen.findByRole('dialog');
    // Controlled input + userEvent.type races in React 19 (only the first
    // character commits), so fire a single change event carrying the value
    // via target.value (the canonical RTL pattern for controlled inputs).
    fireEvent.change(within(dialog).getByPlaceholderText('providers.openai'), {
      target: { value: 'providers.openai' },
    });
    // The JSON value contains `{`/`}` which userEvent.type parses as
    // keyboard-modifier descriptors, so fire a change event directly on the
    // textarea.
    fireEvent.change(within(dialog).getByPlaceholderText('{}'), {
      target: { value: JSON.stringify({ apiKey: 'sk-test' }) },
    });
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.getByText('providers.openai')).toBeInTheDocument();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/config/providers.openai',
      expect.objectContaining({ method: 'PUT' })
    );
  });

  it('edit of a secret omits value to keep current', async () => {
    const mockFetch = stubFetch((url, init) => {
      if (url === '/api/config' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, [secretEntry]);
      }
      if (url === '/api/config/providers.openai' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<
          string,
          unknown
        >;
        expect(body).not.toHaveProperty('value');
        return jsonResponse(200, secretEntry);
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderConfig();
    await screen.findByText('providers.openai');
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);

    const dialog = await screen.findByRole('dialog');
    // Leave the value textarea empty (write-only keep-current sentinel).
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.getByText('providers.openai')).toBeInTheDocument();
    });
    const putCalls = mockFetch.mock.calls.filter(
      call =>
        call[0] === '/api/config/providers.openai' &&
        (call[1] as RequestInit | undefined)?.method === 'PUT'
    );
    expect(putCalls.length).toBe(1);
  });

  it('delete dialog DELETE deletes the entry', async () => {
    const mockFetch = stubFetch((url, init) => {
      if (url === '/api/config' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, [secretEntry]);
      }
      if (url === '/api/config/providers.openai' && init?.method === 'DELETE') {
        return jsonResponse(200, { success: true });
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderConfig();
    await screen.findByText('providers.openai');
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Delete' })
    );

    await waitFor(() => {
      expect(screen.queryByText('providers.openai')).toBeNull();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/config/providers.openai',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('shows an error toast and keeps the row when delete fails', async () => {
    stubFetch((url, init) => {
      if (url === '/api/config' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, [secretEntry]);
      }
      if (url === '/api/config/providers.openai' && init?.method === 'DELETE') {
        return jsonResponse(409, { error: 'Config key is in use' });
      }
      return jsonResponse(404, { error: 'unexpected call' });
    });

    renderConfig();
    await screen.findByText('providers.openai');
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Delete' })
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Config key is in use');
    await waitFor(() => {
      expect(screen.getByText('providers.openai')).toBeInTheDocument();
    });
  });
});

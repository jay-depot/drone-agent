import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PersonaEditorPage from './persona-editor';
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

const existingPersona = {
  id: 'helper',
  name: 'Helper',
  description: 'Helps with tasks',
  systemPrompt: 'You are a helpful assistant.',
  scope: 'coordinator',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

function renderEditor(initialEntries: string[]) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/personas" element={<h1>Personas List</h1>} />
          <Route path="/personas/new" element={<PersonaEditorPage />} />
          <Route path="/personas/:id" element={<h1>Persona Detail</h1>} />
          <Route path="/personas/:id/edit" element={<PersonaEditorPage />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

describe('PersonaEditorPage', () => {
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
        json: async () => existingPersona,
      } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    // History stack: /personas first, then /personas/helper/edit. Navigating
    // back (-1) should land on the /personas list, NOT /personas/helper detail.
    renderEditor(['/personas', '/personas/helper/edit']);

    await waitFor(() => {
      expect(screen.getByLabelText(/ID/)).toHaveValue('helper');
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /← Back/ }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Personas List' })
      ).toBeInTheDocument();
    });
  });

  it('shows only ID, Scope, and System Prompt — no Name or Description fields', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => existingPersona,
      } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    renderEditor(['/personas/helper/edit']);

    await waitFor(() => {
      expect(screen.getByLabelText(/ID/)).toHaveValue('helper');
    });

    expect(screen.getByLabelText(/ID/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Scope/)).toBeInTheDocument();
    expect(screen.getByLabelText(/System Prompt/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Name/)).toBeNull();
    expect(screen.queryByLabelText(/Description/)).toBeNull();
  });

  it('omits name/description from the create request body', async () => {
    const mockFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 'newbie',
            name: 'newbie',
            description: 'Persona: newbie',
            systemPrompt: 'Body',
            scope: 'coordinator',
          }),
        } as Response;
      }
    );
    vi.stubGlobal('fetch', mockFetch);

    renderEditor(['/personas/new']);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/ID/), 'newbie');
    await user.type(screen.getByLabelText(/System Prompt/), 'Body');
    await user.click(screen.getByRole('button', { name: /Create Persona/ }));

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
        )
      ).toBeDefined();
    });

    const post = mockFetch.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    )!;
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body).toEqual({
      id: 'newbie',
      systemPrompt: 'Body',
      scope: 'coordinator',
    });
  });
});

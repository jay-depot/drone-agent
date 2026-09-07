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

describe('PersonaEditorPage back buttons', () => {
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

    const PersonasStub = () => <h1>Personas List</h1>;
    const PersonaDetailStub = () => <h1>Persona Detail</h1>;

    // History stack: /personas first, then /personas/helper/edit. Navigating
    // back (-1) should land on the /personas list, NOT /personas/helper detail.
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/personas', '/personas/helper/edit']}>
          <Routes>
            <Route path="/personas" element={<PersonasStub />} />
            <Route path="/personas/:id" element={<PersonaDetailStub />} />
            <Route path="/personas/:id/edit" element={<PersonaEditorPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Name/)).toHaveValue('Helper');
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /← Back/ }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Personas List' })
      ).toBeInTheDocument();
    });
  });
});

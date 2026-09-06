import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import SkillEditorPage from './skill-editor';
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

const existingSkill = {
  id: 'deploy',
  name: 'Deploy',
  description: 'Deploys a service',
  trigger: 'when asked to deploy',
  body: '# Deploy',
  scope: 'coordinator',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

describe('SkillEditorPage back buttons', () => {
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
        json: async () => existingSkill,
      } as Response;
    });
    vi.stubGlobal('fetch', mockFetch);

    const SkillsStub = () => <h1>Skills List</h1>;
    const SkillDetailStub = () => <h1>Skill Detail</h1>;

    // History stack: /skills first, then /skills/deploy/edit. Navigating back
    // (-1) should land on the /skills list, NOT /skills/deploy detail.
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/skills', '/skills/deploy/edit']}>
          <Routes>
            <Route path="/skills" element={<SkillsStub />} />
            <Route path="/skills/:id" element={<SkillDetailStub />} />
            <Route path="/skills/:id/edit" element={<SkillEditorPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/Name/)).toHaveValue('Deploy');
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /← Back/ }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Skills List' })
      ).toBeInTheDocument();
    });
  });
});

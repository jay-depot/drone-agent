import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ExtensionProvider, ExtensionRouteFallback } from './ExtensionContext';
import { ToastProvider } from '@/hooks/use-toast';

// The provider's loader does a dynamic import(); stub it out. The mutable
// `loading` value drives the fallback under test.
const mocks = vi.hoisted(() => ({ loading: true }));

vi.mock('./useExtensions', () => ({
  useExtensions: () => ({ load: () => [], loaded: [], loading: mocks.loading }),
}));

function PathProbe() {
  const { pathname } = useLocation();
  return <div data-testid="pathname">{pathname}</div>;
}

function renderAtBoard() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/board']}>
        <ExtensionProvider>
          <Routes>
            <Route path="/" element={<div>HOME</div>} />
            <Route path="*" element={<ExtensionRouteFallback />} />
          </Routes>
          <PathProbe />
        </ExtensionProvider>
      </MemoryRouter>
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.loading = true;
});

describe('ExtensionRouteFallback', () => {
  it('shows a skeleton and does not redirect while extensions load', () => {
    mocks.loading = true;
    renderAtBoard();
    expect(
      document.querySelector('[data-slot="skeleton"]')
    ).toBeInTheDocument();
    expect(screen.getByTestId('pathname').textContent).toBe('/board');
    expect(screen.queryByText('HOME')).toBeNull();
  });

  it('redirects to the topology page once the load settles', async () => {
    mocks.loading = false;
    renderAtBoard();
    await waitFor(() => {
      expect(screen.getByTestId('pathname').textContent).toBe('/');
    });
    expect(screen.getByText('HOME')).toBeInTheDocument();
  });
});

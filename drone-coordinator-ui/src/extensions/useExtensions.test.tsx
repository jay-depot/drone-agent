import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider } from '@/hooks/use-auth';
import { useExtensions } from './useExtensions';

function Probe({ onLoad }: { onLoad: (load: unknown) => void }) {
  const { load } = useExtensions(() => {});
  const navigate = useNavigate();
  useLocation();
  onLoad(load);
  return (
    <button type="button" onClick={() => navigate('/board')}>
      go
    </button>
  );
}

describe('useExtensions', () => {
  it('keeps the load reference stable across navigation', () => {
    const seen: unknown[] = [];
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/']}>
          <Probe onLoad={load => seen.push(load)} />
        </MemoryRouter>
      </AuthProvider>
    );
    const first = seen[seen.length - 1];

    act(() => {
      document.querySelector('button')!.click();
    });

    const second = seen[seen.length - 1];
    expect(second).toBe(first);
  });
});

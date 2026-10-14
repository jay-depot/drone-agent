import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { AuthProvider } from '@/hooks/use-auth';
import {
  ExtensionProvider,
  RegionSlot,
  ExtensionSections,
  useExtensionRegistry,
} from './ExtensionContext';

// The provider's loader does a dynamic import(); stub it out globally.
vi.mock('./useExtensions', () => ({
  useExtensions: () => ({ load: () => [], loaded: [] }),
}));

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

/**
 * Probe component: registers components into regions imperatively so the
 * test can assert RegionSlot / ExtensionSections rendering without a real
 * bundle import.
 */
function Probe() {
  const { registerComponent } = useExtensionRegistry();
  return (
    <button
      onClick={() => {
        registerComponent('topology-widget', () => <span>WIDGET</span>);
        registerComponent(
          'settings-panel',
          () => <span>SETTINGS-PANEL</span>,
          'ext-1'
        );
      }}
    >
      register
    </button>
  );
}

function renderWithProvider(ui: React.ReactNode) {
  return render(
    <AuthProvider>
      <ExtensionProvider>
        <Probe />
        {ui}
      </ExtensionProvider>
    </AuthProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RegionSlot', () => {
  it('renders nothing when the region is empty', () => {
    renderWithProvider(<RegionSlot region="topology-widget" />);
    expect(screen.queryByText('WIDGET')).toBeNull();
  });

  it('renders a registered component', async () => {
    renderWithProvider(<RegionSlot region="topology-widget" />);
    act(() => {
      screen.getByRole('button', { name: 'register' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText('WIDGET')).toBeInTheDocument();
    });
  });
});

describe('ExtensionSections', () => {
  it('renders a core-provided heading per extension panel', async () => {
    renderWithProvider(<ExtensionSections />);
    act(() => {
      screen.getByRole('button', { name: 'register' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText('ext-1')).toBeInTheDocument();
      expect(screen.getByText('SETTINGS-PANEL')).toBeInTheDocument();
    });
  });
});

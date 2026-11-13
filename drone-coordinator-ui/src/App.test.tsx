import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

// WebSocket stub (the app opens a socket on mount).
class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  url = '';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
vi.stubGlobal('WebSocket', MockWebSocket);

// Replace the dynamic-import bundle load with a simulated bundle that
// registers a `/board` route. Everything else in the loader is real.
vi.mock('./extensions/loader', async importOriginal => {
  const actual = await importOriginal<typeof import('./extensions/loader')>();
  return {
    ...actual,
    loadExtensionBundles: vi.fn(
      async (
        _entries: Parameters<typeof actual.loadExtensionBundles>[0],
        deps: Parameters<typeof actual.loadExtensionBundles>[1]
      ) => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const Board = () => <h1>BOARD</h1>;
        const dispose = deps.registerRoute({
          path: '/board',
          title: 'Board',
          component: Board,
        });
        return { disposers: [dispose], loaded: ['node-1'] };
      }
    ),
  };
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

const manifest = [
  {
    nodeId: 'node-1',
    connected: true,
    protocolVersion: 1,
    capabilities: [],
    bundles: [
      { name: 'board', version: '1', hash: 'h', scriptUrls: ['/b.js'] },
    ],
  },
];

beforeEach(() => {
  window.history.pushState({}, '', '/board');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) =>
      String(url) === '/api/extensions'
        ? jsonResponse(200, manifest)
        : jsonResponse(404, {})
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

describe('App extension routes', () => {
  it('renders an extension route on a full page load without redirecting', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('BOARD')).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe('/board');
  });

  it('shows a host-rendered sidebar link for the extension route', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Board/ })).toHaveAttribute(
        'href',
        '/board'
      );
    });
  });

  it('keeps the extension route and its nav link after navigating to it', async () => {
    const user = userEvent.setup();
    window.history.pushState({}, '', '/');
    render(<App />);

    const link = await screen.findByRole('link', { name: /Board/ });
    await user.click(link);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/board');
      expect(screen.getByText('BOARD')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Board/ })).toBeInTheDocument();
  });
});

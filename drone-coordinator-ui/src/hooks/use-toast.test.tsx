import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast, TOAST_DURATION_MS } from './use-toast';

afterEach(() => {
  vi.useRealTimers();
});

function ToastEmitter({ messages }: { messages: string[] }) {
  const { error } = useToast();
  return (
    <button
      onClick={() => {
        messages.forEach(m => error(m));
      }}
    >
      emit
    </button>
  );
}

function renderToaster(messages: string[]) {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <ToastEmitter messages={messages} />
    </ToastProvider>
  );
  return user;
}

describe('ToastProvider', () => {
  it('renders an error toast with a dismiss button', async () => {
    const user = renderToaster(['boom']);

    await user.click(screen.getByRole('button', { name: 'emit' }));

    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('auto-dismisses after the toast duration', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = renderToaster(['transient']);

    await user.click(screen.getByRole('button', { name: 'emit' }));
    expect(screen.getByRole('alert')).toHaveTextContent('transient');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS + 1);
    });

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('stacks multiple toasts', async () => {
    const user = renderToaster(['one', 'two']);

    await user.click(screen.getByRole('button', { name: 'emit' }));

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('one');
    expect(alerts[1]).toHaveTextContent('two');
  });

  it('caps the stack at MAX_TOASTS, dropping the oldest', async () => {
    const user = renderToaster(['a', 'b', 'c', 'd', 'e', 'f']);

    await user.click(screen.getByRole('button', { name: 'emit' }));

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(4);
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.queryByText('b')).not.toBeInTheDocument();
    expect(screen.getByText('c')).toBeInTheDocument();
    expect(screen.getByText('f')).toBeInTheDocument();
  });

  it('dismisses manually via the dismiss button', async () => {
    const user = renderToaster(['manual']);

    await user.click(screen.getByRole('button', { name: 'emit' }));
    expect(screen.getByRole('alert')).toHaveTextContent('manual');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('throws when useToast is used outside a provider', () => {
    function Orphan() {
      useToast();
      return null;
    }
    // Silence the expected error boundary noise from the render call.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Orphan />)).toThrow(
      'useToast must be used within a ToastProvider'
    );
  });
});

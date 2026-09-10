import {
  useState,
  useCallback,
  useRef,
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export const TOAST_DURATION_MS = 5000;
export const MAX_TOASTS = 4;

interface ToastItem {
  id: number;
  message: string;
}

interface ToastContextValue {
  /** Show a transient error toast (auto-dismisses after 5s). */
  error: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const error = useCallback(
    (message: string) => {
      const id = nextId.current++;
      // Cap the visible stack: drop the oldest toasts beyond MAX_TOASTS.
      setToasts(prev => [...prev.slice(-(MAX_TOASTS - 1)), { id, message }]);
      setTimeout(() => dismiss(id), TOAST_DURATION_MS);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ error }}>
      {children}
      <div
        aria-live="assertive"
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      >
        {toasts.map(toast => (
          <div
            key={toast.id}
            role="alert"
            className={cn(
              'flex items-center gap-2 p-3 rounded-md border',
              'border-destructive/40 bg-destructive/10 text-destructive text-sm'
            )}
          >
            <span>{toast.message}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

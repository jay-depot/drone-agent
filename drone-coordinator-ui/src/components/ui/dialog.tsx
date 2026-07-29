import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  loading?: boolean;
  children?: ReactNode;
}

function Dialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  loading = false,
  children,
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />

      {/* Dialog */}
      <div
        ref={dialogRef}
        className={cn(
          'relative z-50 w-full max-w-md rounded-xl bg-card p-6 shadow-lg ring-1 ring-foreground/10',
          'animate-in fade-in zoom-in-95 duration-200'
        )}
      >
        <h2
          id="dialog-title"
          className="text-lg font-semibold text-card-foreground"
        >
          {title}
        </h2>

        {description && (
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        )}

        {children && <div className="mt-4">{children}</div>}

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? 'Processing...' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export { Dialog };

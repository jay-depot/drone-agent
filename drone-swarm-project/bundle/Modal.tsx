import type { ReactNode } from 'react';
import { Button } from './Button';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The shared modal shell.
 *
 * It owns the backdrop, the panel, the header (title and Close), and the
 * Escape listener. The children are the body only. A click on the backdrop
 * closes the modal; a click on the panel does not.
 */
export function Modal({ title, onClose, children }: ModalProps) {
  const React = globalThis.React;

  React.useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dsp-modal-backdrop" onClick={onClose}>
      <div className="dsp-modal" onClick={event => event.stopPropagation()}>
        <header className="dsp-modal-header">
          <h2>{title}</h2>
          <Button onClick={onClose}>Close</Button>
        </header>
        {children}
      </div>
    </div>
  );
}

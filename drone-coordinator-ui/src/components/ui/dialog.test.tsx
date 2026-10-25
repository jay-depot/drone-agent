import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dialog } from './dialog';

type DialogProps = Parameters<typeof Dialog>[0];

function renderDialog(props: Partial<DialogProps> = {}): HTMLElement {
  const { container } = render(
    <Dialog
      open
      onClose={() => {}}
      onConfirm={() => {}}
      title="Test Dialog"
      {...props}
    />
  );
  return (
    screen.getByRole('heading', { name: 'Test Dialog' }).parentElement ??
    (container.firstElementChild as HTMLElement)
  );
}

describe('Dialog', () => {
  it('defaults to the md width', () => {
    const dialog = renderDialog();
    expect(dialog.className).toContain('max-w-md');
    expect(dialog.className).not.toContain('max-w-2xl');
  });

  it('applies the lg width when requested', () => {
    expect(renderDialog({ width: 'lg' }).className).toContain('max-w-2xl');
  });

  it('applies the xl width when requested', () => {
    expect(renderDialog({ width: 'xl' }).className).toContain('max-w-4xl');
  });
});

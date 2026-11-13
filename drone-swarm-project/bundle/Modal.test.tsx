import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders the title and the children', () => {
    render(
      <Modal title="Thing" onClose={() => {}}>
        <p>Body</p>
      </Modal>
    );
    expect(screen.getByRole('heading', { name: 'Thing' })).toBeInTheDocument();
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  it('calls onClose on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal title="Thing" onClose={onClose}>
        <p>Body</p>
      </Modal>
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on a backdrop click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="Thing" onClose={onClose}>
        <p>Body</p>
      </Modal>
    );
    await user.click(container.querySelector('.dsp-modal-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose on a panel click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal title="Thing" onClose={onClose}>
        <p>Body</p>
      </Modal>
    );
    await user.click(screen.getByText('Body'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

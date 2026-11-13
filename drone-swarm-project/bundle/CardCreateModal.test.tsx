import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CardCreateModal } from './CardCreateModal';
import { setApi } from './api';

function installApi(reply: unknown) {
  const fetchImpl = vi.fn(async (_path: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => reply,
  }));
  setApi({
    registerComponent: () => () => {},
    registerRoute: () => () => {},
    fetch: fetchImpl as unknown as typeof fetch,
    navigate: () => {},
    ui: {
      errors: {
        show: vi.fn(),
        fromResponse: vi.fn(async () => 'x'),
        fromThrown: vi.fn(() => 'thrown'),
      },
    },
  });
  return fetchImpl;
}

const props = {
  projectId: 'p_1',
  columnId: 'col_todo',
  columnName: 'Todo',
  onClose: () => {},
  onCreated: () => {},
};

describe('CardCreateModal', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('starts empty and shows the fixed column', () => {
    installApi({ ok: true, body: {} });
    render(<CardCreateModal {...props} />);
    expect(screen.getByText('Column: Todo')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Description')).toHaveValue('');
  });

  it('disables Create while the title is empty', () => {
    installApi({ ok: true, body: {} });
    render(<CardCreateModal {...props} />);
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('sends card.create with the column and the fields', async () => {
    const user = userEvent.setup();
    const fetchImpl = installApi({ ok: true, body: { card: { id: 'c_9' } } });
    const onCreated = vi.fn();
    render(<CardCreateModal {...props} onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Title'), 'New thing');
    await user.type(screen.getByLabelText('Description'), 'Details');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const call = fetchImpl.mock.calls.find(call =>
      String(call[0]).includes('card.create')
    );
    const sent = JSON.parse(String((call![1] as RequestInit).body));
    expect(sent.params.projectId).toBe('p_1');
    expect(sent.params.columnId).toBe('col_todo');
    expect(sent.params.title).toBe('New thing');
    expect(sent.params.description).toBe('Details');
  });

  it('shows an inline error and stays open on failure', async () => {
    const user = userEvent.setup();
    installApi({ ok: false, status: 400, body: { error: 'bad card' } });
    const onCreated = vi.fn();
    render(<CardCreateModal {...props} onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Title'), 'X');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('bad card')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    installApi({ ok: true, body: {} });
    const onClose = vi.fn();
    render(<CardCreateModal {...props} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

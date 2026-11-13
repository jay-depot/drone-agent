import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CardModal } from './CardModal';
import { setApi } from './api';
import type { Card, Project } from './types';

const project: Project = {
  id: 'p_1',
  name: 'Alpha',
  columns: [
    { id: 'col_todo', name: 'Todo', order: 0 },
    { id: 'col_done', name: 'Done', order: 1 },
  ],
  cards: [],
};

const card: Card = {
  id: 'c_1',
  title: 'Old title',
  description: 'Old body',
  columnId: 'col_todo',
  position: 0,
  sessionStatus: 'running',
  sessionId: 'sess-1',
  history: [
    { at: 1000, actor: 'user', fromColumnId: null, toColumnId: 'col_todo' },
  ],
};

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

describe('CardModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds the editable fields from the card', () => {
    installApi({ ok: true, body: {} });
    render(
      <CardModal
        project={project}
        card={card}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    expect(screen.getByDisplayValue('Old title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Old body')).toBeInTheDocument();
  });

  it('shows the read-only details', () => {
    installApi({ ok: true, body: {} });
    render(
      <CardModal
        project={project}
        card={card}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('Todo')).toBeInTheDocument();
    expect(screen.getByText('sess-1')).toBeInTheDocument();
  });

  it('sends card.update on Save and calls onSaved', async () => {
    const user = userEvent.setup();
    const fetchImpl = installApi({ ok: true, body: { card } });
    const onSaved = vi.fn();
    render(
      <CardModal
        project={project}
        card={card}
        onClose={() => {}}
        onSaved={onSaved}
      />
    );
    const input = screen.getByDisplayValue('Old title');
    await user.clear(input);
    await user.type(input, 'New title');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const [, init] = fetchImpl.mock.calls[0]!;
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent.params.title).toBe('New title');
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('card.update');
  });

  it('shows an inline error and stays open when the reply is not ok', async () => {
    const user = userEvent.setup();
    installApi({ ok: false, status: 400, body: { error: 'bad card' } });
    const onSaved = vi.fn();
    render(
      <CardModal
        project={project}
        card={card}
        onClose={() => {}}
        onSaved={onSaved}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('bad card')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    installApi({ ok: true, body: {} });
    const onClose = vi.fn();
    render(
      <CardModal
        project={project}
        card={card}
        onClose={onClose}
        onSaved={() => {}}
      />
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

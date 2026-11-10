import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardPage } from './BoardPage';
import { setApi } from './api';

const project = {
  id: 'p_1',
  name: 'Alpha',
  columns: [{ id: 'col_todo', name: 'Todo', order: 0 }],
  cards: [
    {
      id: 'c_1',
      title: 'Card one',
      columnId: 'col_todo',
      position: 0,
      history: [],
    },
  ],
};

function installApi() {
  setApi({
    registerComponent: () => () => {},
    registerRoute: () => () => {},
    fetch: vi.fn(async (path: string) => ({
      ok: true,
      json: async () =>
        String(path).endsWith('/project.list')
          ? {
              ok: true,
              body: { projects: [{ id: 'p_1', name: 'Alpha', cardCount: 1 }] },
            }
          : { ok: true, body: { project } },
    })) as unknown as typeof fetch,
    navigate: () => {},
    ui: {
      errors: {
        show: vi.fn(),
        fromResponse: vi.fn(async () => 'x'),
        fromThrown: vi.fn(() => 'x'),
      },
    },
  });
}

describe('BoardPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('opens the card modal on a click', async () => {
    const user = userEvent.setup();
    installApi();
    render(<BoardPage />);
    const title = await screen.findByText('Card one');
    await user.click(title);
    expect(
      await screen.findByRole('button', { name: 'Save' })
    ).toBeInTheDocument();
  });

  it('does not open the modal when the click follows a drag', async () => {
    installApi();
    render(<BoardPage />);
    const title = await screen.findByText('Card one');
    const cardEl = title.closest('.dsp-card')!;
    // A real drag fires dragStart then dragEnd then a click, all in one turn,
    // before the scheduled didDrag reset. Drive them synchronously to match.
    fireEvent.dragStart(cardEl);
    fireEvent.dragEnd(cardEl);
    fireEvent.click(title);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

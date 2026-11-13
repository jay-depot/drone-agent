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

const projectSummaries = [{ id: 'p_1', name: 'Alpha', cardCount: 1 }];

function installApi(projects = projectSummaries) {
  setApi({
    registerComponent: () => () => {},
    registerRoute: () => () => {},
    fetch: vi.fn(async (path: string) => ({
      ok: true,
      json: async () =>
        String(path).endsWith('/project.list')
          ? { ok: true, body: { projects } }
          : String(path).endsWith('/api/beacons')
            ? []
            : String(path).endsWith('/api/extensions')
              ? []
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

  it('opens the New Project modal from the sentinel option', async () => {
    const user = userEvent.setup();
    installApi();
    render(<BoardPage />);
    const select = await screen.findByRole('combobox');
    await user.selectOptions(select, '__new_project__');
    expect(
      await screen.findByRole('button', { name: 'Create' })
    ).toBeInTheDocument();
  });

  it('disables Edit Project when there is no project', async () => {
    installApi([]);
    render(<BoardPage />);
    const edit = await screen.findByRole('button', { name: 'Edit Project' });
    expect(edit).toBeDisabled();
  });

  it('shows the empty hint and New Project button with zero projects', async () => {
    installApi([]);
    render(<BoardPage />);
    expect(await screen.findByText('No projects yet.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'New Project' })
    ).toBeInTheDocument();
  });

  it('centers the columns area when there are no projects', async () => {
    installApi([]);
    render(<BoardPage />);
    const hint = (await screen.findByText('No projects yet.')).closest(
      '.dsp-columns'
    );
    expect(hint).toHaveClass('dsp-columns-empty');
  });

  it('shows the selected project name as the title', async () => {
    installApi();
    render(<BoardPage />);
    expect(
      await screen.findByRole('heading', { name: 'Alpha' })
    ).toBeInTheDocument();
  });

  it('falls back to the Board title with no projects', async () => {
    installApi([]);
    render(<BoardPage />);
    expect(
      await screen.findByRole('heading', { name: 'Board' })
    ).toBeInTheDocument();
  });

  it('renders one Add card button per column with a column label', async () => {
    installApi();
    render(<BoardPage />);
    const button = await screen.findByRole('button', {
      name: 'Add card to Todo',
    });
    expect(button).toBeInTheDocument();
  });

  it('opens the new-card modal from the column button', async () => {
    const user = userEvent.setup();
    installApi();
    render(<BoardPage />);
    await user.click(
      await screen.findByRole('button', { name: 'Add card to Todo' })
    );
    expect(
      await screen.findByRole('heading', { name: 'New card' })
    ).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import WikiPageTable from './wiki-page-table';
import type { WikiPageMeta } from '@/lib/types';

function page(overrides: Partial<WikiPageMeta> = {}): WikiPageMeta {
  return {
    id: 'p',
    title: 'P',
    scope: 'coordinator',
    tags: [],
    sources: [],
    wordCount: 0,
    linkCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderTable(
  pages: WikiPageMeta[],
  handlers: {
    onSort?: (key: string) => void;
    onDelete?: (p: WikiPageMeta) => void;
  } = {}
) {
  return render(
    <MemoryRouter>
      <Routes>
        <Route
          path="*"
          element={
            <WikiPageTable
              pages={pages}
              sortKey={null}
              sortDir="asc"
              onSort={handlers.onSort as never}
              onDelete={handlers.onDelete}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('WikiPageTable', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the six columns with a plain Tags header', () => {
    renderTable([page({ title: 'Alpha' })]);

    for (const header of [
      'Title',
      'Created',
      'Updated',
      'Word Count',
      'Source Sessions',
    ]) {
      expect(
        screen.getByRole('button', { name: new RegExp(header) })
      ).toBeTruthy();
    }
    // Tags is a plain (non-sortable) header, so no button.
    expect(screen.getByRole('columnheader', { name: 'Tags' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Tags/ })).toBeNull();
  });

  it('uses a fixed layout so the Title column truncates and the rest hold width', () => {
    renderTable([
      page({ title: 'A very long wiki page title that should be truncated' }),
    ]);

    expect(screen.getByRole('table').className).toContain('table-fixed');
    const title = screen.getByText(
      'A very long wiki page title that should be truncated'
    );
    expect(title.className).toContain('truncate');
  });

  it('centers the Created, Updated, and Source Sessions columns', () => {
    renderTable([
      page({
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      }),
    ]);

    for (const label of ['Created', 'Updated', 'Source Sessions']) {
      expect(
        screen.getByRole('columnheader', { name: new RegExp(label) }).className
      ).toContain('text-center');
    }

    // Body cells line up under the centered headers (0=Title, 1=Tags,
    // 2=Created, 3=Updated, 4=Word Count, 5=Sources).
    const bodyRow = screen.getAllByRole('row')[1];
    const cells = within(bodyRow).getAllByRole('cell');
    expect(cells[2].className).toContain('text-center');
    expect(cells[3].className).toContain('text-center');
    expect(cells[5].className).toContain('text-center');
    expect(cells[0].className).not.toContain('text-center');
  });

  it('caps the tag badges at 3 and shows a +N chip', () => {
    renderTable([page({ tags: ['a', 'b', 'c', 'd', 'e'] })]);

    for (const tag of ['a', 'b', 'c']) {
      expect(screen.getByText(tag)).toBeTruthy();
    }
    expect(screen.queryByText('d')).toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();
  });

  it('renders the source count, with the IDs in a tooltip', () => {
    renderTable([page({ sources: ['s1', 's2'] })]);

    const cell = screen.getByText('2');
    expect(cell).toHaveAttribute('title', 's1, s2');
  });

  it('renders the word count', () => {
    renderTable([page({ wordCount: 123 })]);

    expect(screen.getByText('123')).toBeTruthy();
  });

  it('invokes onSort with the column key when a header is clicked', async () => {
    const onSort = vi.fn();
    renderTable([page()], { onSort });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Word Count/ }));
    expect(onSort).toHaveBeenCalledWith('words');
  });

  it('navigates to the page on a row click', async () => {
    render(
      <MemoryRouter initialEntries={['/wiki']}>
        <Routes>
          <Route
            path="/wiki"
            element={
              <WikiPageTable
                pages={[page({ id: 'deploy', title: 'Deployment' })]}
                sortKey={null}
                sortDir="asc"
              />
            }
          />
          <Route path="/wiki/:pageId" element={<div>DETAIL</div>} />
        </Routes>
      </MemoryRouter>
    );

    const user = userEvent.setup();
    await user.click(screen.getByText('Deployment'));
    expect(screen.getByText('DETAIL')).toBeTruthy();
  });

  it('calls onDelete from the Delete button without navigating', async () => {
    const onDelete = vi.fn();
    renderTable([page({ id: 'deploy', title: 'Deployment' })], { onDelete });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0][0].id).toBe('deploy');
  });
});

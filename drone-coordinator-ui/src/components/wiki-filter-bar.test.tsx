import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import WikiFilterBar from './wiki-filter-bar';
import { DEFAULT_WIKI_FILTERS, type WikiFilters } from '@/lib/wiki-filters';
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

const pages = [page({ tags: ['ops', 'design'], sources: ['session-abc'] })];

// The inputs are controlled, so the harness keeps its own state; otherwise
// each keystroke would start from the initial (empty) value.
function Harness({
  initial = DEFAULT_WIKI_FILTERS,
  onChange = () => {},
  onClear = () => {},
}: {
  initial?: WikiFilters;
  onChange?: (next: WikiFilters) => void;
  onClear?: () => void;
}) {
  const [filters, setFilters] = useState(initial);
  return (
    <WikiFilterBar
      filters={filters}
      onChange={next => {
        setFilters(next);
        onChange(next);
      }}
      onClear={onClear}
      pages={pages}
    />
  );
}

function renderBar(
  filters: WikiFilters = DEFAULT_WIKI_FILTERS,
  onChange = vi.fn(),
  onClear = vi.fn()
) {
  render(
    <MemoryRouter>
      <Harness initial={filters} onChange={onChange} onClear={onClear} />
    </MemoryRouter>
  );
  return { onChange, onClear };
}

describe('WikiFilterBar', () => {
  it('writes the tag filter when the tag input changes', async () => {
    const { onChange } = renderBar();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Filter by tags'), 'ops');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: ['ops'] })
    );
  });

  it('parses a comma-separated tag list into tokens', async () => {
    const { onChange } = renderBar();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Filter by tags'), 'ops, design');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: ['ops', 'design'] })
    );
  });

  it('writes the source filter when the source input changes', async () => {
    const { onChange } = renderBar();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Filter by source session'), 'abc');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sources: ['abc'] })
    );
  });

  it('toggles the date field between created and updated', async () => {
    const { onChange } = renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Created' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ dateField: 'created' })
    );
  });

  it('toggles the page-state buttons', async () => {
    const { onChange } = renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Has links' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasLinks: true })
    );
    await user.click(screen.getByRole('button', { name: 'Recently created' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ recentlyCreated: true })
    );
  });

  it('hides the count and Clear when no filters are active', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('shows the active-filter count and a Clear button', async () => {
    const { onClear } = renderBar({
      ...DEFAULT_WIKI_FILTERS,
      tags: ['ops'],
      hasLinks: true,
    });
    expect(screen.getByText('2 filters')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

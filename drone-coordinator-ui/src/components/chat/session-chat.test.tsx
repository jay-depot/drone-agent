import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildToolRows, SessionChat } from './session-chat';
import type { ChatFeedItem } from '@/lib/chat-types';

function item(partial: Partial<ChatFeedItem> & { id: string }): ChatFeedItem {
  return {
    type: 'notice',
    correlationId: null,
    createdAt: 1000,
    preview: '',
    hasFull: false,
    ...partial,
  };
}

function truncatedItem(id: string, visible: string, hidden: number) {
  return item({
    id,
    type: 'assistantMessage',
    preview: `${visible}…[+${hidden} chars]`,
    hasFull: true,
  });
}

function placeholderItem(id: string) {
  return item({
    id,
    type: 'userMessage',
    preview: '(large content — expand to load)',
    hasFull: true,
  });
}

describe('buildToolRows (batch splitting + positional pairing)', () => {
  it('pairs calls and results positionally within a turn', () => {
    const rows = buildToolRows([
      item({
        id: 'call1',
        type: 'toolCallBatch',
        preview: JSON.stringify({
          toolCalls: [
            { name: 'file__read', arguments: { path: '/a' } },
            { name: 'file__read', arguments: { path: '/b' } },
          ],
        }),
        name: 'file__read',
      }),
      item({
        id: 'res1',
        type: 'toolResultBatch',
        preview: JSON.stringify({
          results: [
            { name: 'file__read', content: 'A content' },
            { name: 'file__read', content: 'B content' },
          ],
        }),
        name: 'file__read',
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      callId: 'call1',
      name: 'file__read',
      resultContent: 'A content',
      resultId: 'res1',
    });
    expect(rows[1]).toMatchObject({
      callId: 'call1',
      name: 'file__read',
      resultContent: 'B content',
      resultId: 'res1',
    });
  });

  it('renders an orphan result (page boundary) as a result-only row', () => {
    const rows = buildToolRows([
      item({
        id: 'res1',
        type: 'toolResultBatch',
        preview: JSON.stringify({
          results: [{ name: 'x', content: 'orphan' }],
        }),
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.callId).toBeNull();
    expect(rows[0]!.resultContent).toBe('orphan');
    expect(rows[0]!.resultId).toBe('res1');
  });

  it('flags a blobbed result (empty preview + hasFull) as pending content', () => {
    const rows = buildToolRows([
      item({
        id: 'call1',
        type: 'toolCallBatch',
        preview: JSON.stringify({ toolCalls: [{ name: 'big' }] }),
      }),
      item({
        id: 'res1',
        type: 'toolResultBatch',
        preview: '',
        hasFull: true,
        name: 'big',
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resultId).toBe('res1');
    expect(rows[0]!.resultContent).toBeNull();
  });
});

describe('SessionChat unresolvable-placeholder expansion', () => {
  function placeholderItem(id: string) {
    return item({
      id,
      type: 'userMessage',
      preview: '(large content — expand to load)',
      hasFull: true,
    });
  }

  it('loads and renders a placeholder message with local re-truncation', async () => {
    const user = userEvent.setup();
    const bigBody = 'z'.repeat(9000);
    mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/sessions/agent-1/chat')) {
        return Promise.resolve(
          jsonResponse(200, {
            items: [placeholderItem('a1')],
            hasMore: false,
            oldestCursor: null,
          })
        );
      }
      if (url.includes('/content')) {
        return Promise.resolve(
          jsonResponse(200, {
            id: 'a1',
            type: 'userMessage',
            payload: JSON.stringify({ kind: 'userMessage', content: bigBody }),
          })
        );
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
    render(<Harness items={[]} />);

    const trigger = await screen.findByText('(large content — expand to load)');
    expect(trigger.tagName).toBe('BUTTON');
    await user.click(trigger);
    expect(await screen.findByText(/^z{8192}$/)).toBeInTheDocument();
    expect(screen.getByText('…[+808 chars]')).toBeInTheDocument();
    expect(screen.getByText('show less')).toBeInTheDocument();
    await user.click(screen.getByText('show less'));
    expect(
      screen.getByText('(large content — expand to load)')
    ).toBeInTheDocument();
  });

  it('placeholder and slug share the one-expanded-at-a-time policy', async () => {
    const user = userEvent.setup();
    mockFetch = makeFetch([
      placeholderItem('a1'),
      truncatedItem('a2', 'Slug body', 400),
    ]);
    render(<Harness items={[]} />);

    await user.click(
      await screen.findByText('(large content — expand to load)')
    );
    expect(await screen.findByText('FULL CONTENT FOR a1')).toBeInTheDocument();
    await user.click(screen.getByText('…[+400 chars]'));

    await waitFor(() => {
      expect(screen.getByText('FULL CONTENT FOR a2')).toBeInTheDocument();
    });
    // Expanding the slug evicted the placeholder: its content is gone and
    // the placeholder trigger is back.
    expect(screen.queryByText('FULL CONTENT FOR a1')).not.toBeInTheDocument();
    expect(
      screen.getByText('(large content — expand to load)')
    ).toBeInTheDocument();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function makeFetch(
  items: ChatFeedItem[],
  options?: { hasMore?: boolean; oldestCursor?: string | null }
) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.startsWith('/api/sessions/agent-1/chat')) {
      return Promise.resolve(
        jsonResponse(200, {
          items,
          hasMore: options?.hasMore ?? false,
          oldestCursor: options?.oldestCursor ?? null,
        })
      );
    }
    if (url.includes('/content')) {
      const id = url.split('/events/')[1]?.split('/content')[0];
      return Promise.resolve(
        jsonResponse(200, {
          id,
          type: 'toolResultBatch',
          payload: `FULL CONTENT FOR ${id}`,
        })
      );
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
}

let mockFetch: ReturnType<typeof vi.fn>;

vi.mock('@/hooks/use-auth', () => ({
  useAuthenticatedFetch: () => mockFetch,
}));

function Harness({ items }: { items: ChatFeedItem[] }) {
  return <SessionChat sessionId="agent-1" liveItems={items} />;
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SessionChat rendering', () => {
  it('renders a user bubble and an assistant markdown block', async () => {
    mockFetch = makeFetch([
      item({
        id: 'u1',
        type: 'userMessage',
        preview: 'please help',
        correlationId: 'c1',
        createdAt: 1000,
      }),
      item({
        id: 'a1',
        type: 'assistantMessage',
        preview: '# Hi\n\nDo **this**.',
        correlationId: 'c1',
        createdAt: 1001,
      }),
    ]);
    render(<Harness items={[]} />);

    await waitFor(() => {
      expect(screen.getByText('please help')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Hi' })).toBeInTheDocument();
    const strong = screen.getByText('this');
    expect(strong.tagName).toBe('STRONG');
  });

  it('renders lifecycle events as dividers and reasoning muted', async () => {
    mockFetch = makeFetch([
      item({
        id: 'p1',
        type: 'personaChanged',
        preview: JSON.stringify({ from: null, to: 'coder' }),
        createdAt: 1000,
      }),
      item({
        id: 'r1',
        type: 'reasoning',
        preview: 'pondering',
        createdAt: 1001,
      }),
    ]);
    render(<Harness items={[]} />);

    await waitFor(() => {
      expect(screen.getByText('persona → coder')).toBeInTheDocument();
    });
    const reasoning = screen.getByText('pondering');
    expect(reasoning.className).toContain('italic');
    expect(reasoning.className).toContain('muted');
  });

  it('expands a tool chip and fetches full content once (cached)', async () => {
    const user = userEvent.setup();
    mockFetch = makeFetch([
      item({
        id: 'call1',
        type: 'toolCallBatch',
        preview: JSON.stringify({
          toolCalls: [{ name: 'file__read', arguments: { path: '/big' } }],
        }),
        name: 'file__read',
        correlationId: 'c1',
      }),
      item({
        id: 'res1',
        type: 'toolResultBatch',
        preview: '',
        hasFull: true,
        name: 'file__read',
        correlationId: 'c1',
      }),
    ]);
    render(<Harness items={[]} />);

    // Two tool rows render (call batch + result batch); each has a trigger
    // button — click the first (the call chip) and assert one fetch total.
    // Note: the tool name lives on an inner <span>, and the selector option
    // filters the matched element itself — so use a matcher fn that checks
    // the ancestor trigger's data-slot instead.
    const triggerMatcher = (_: string, el: Element | null) =>
      el?.getAttribute('data-slot') === 'collapsible-trigger' &&
      (el.textContent?.includes('file__read') ?? false);
    const chips = await screen.findAllByText(triggerMatcher);
    await user.click(chips[0]!);

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.filter(([url]) => String(url).includes('/content'))
      ).toHaveLength(1);
    });
    // The clicked row is the call chip (callId call1) — content is keyed by
    // the event id in the URL, so the payload label reads call1.
    await screen.findByText('FULL CONTENT FOR call1');

    // Collapse and re-expand: no second content fetch.
    const chips2 = screen.getAllByText(triggerMatcher);
    const firstChip = chips2[0]!;
    await user.click(firstChip);
    await user.click(firstChip);
    await waitFor(() => {
      expect(
        mockFetch.mock.calls.filter(([url]) => String(url).includes('/content'))
      ).toHaveLength(1);
    });
    await screen.findByText('FULL CONTENT FOR call1');
    expect(
      mockFetch.mock.calls.filter(([url]) => String(url).includes('/content'))
    ).toHaveLength(1);
  });
});

describe('SessionChat live append', () => {
  it('renders live items passed via props without refetching', async () => {
    mockFetch = makeFetch([
      item({
        id: 'u1',
        type: 'userMessage',
        preview: 'hello',
        correlationId: 'c1',
        createdAt: 1000,
      }),
    ]);
    const { rerender } = render(<Harness items={[]} />);
    await screen.findByText('hello');

    const before = mockFetch.mock.calls.length;
    rerender(
      <Harness
        items={[
          item({
            id: 'live1',
            type: 'assistantMessage',
            preview: 'live reply',
            correlationId: 'c1',
            createdAt: 1001,
          }),
        ]}
      />
    );
    expect(screen.getByText('live reply')).toBeInTheDocument();
    expect(mockFetch.mock.calls.length).toBe(before);
  });
});

describe('SessionChat truncation-slug expansion', () => {
  it('loads full content when the truncation slug is clicked', async () => {
    const user = userEvent.setup();
    mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/sessions/agent-1/chat')) {
        return Promise.resolve(
          jsonResponse(200, {
            items: [truncatedItem('a1', 'Long reply', 2194)],
            hasMore: false,
            oldestCursor: null,
          })
        );
      }
      if (url.includes('/content')) {
        return Promise.resolve(
          jsonResponse(200, {
            id: 'a1',
            type: 'assistantMessage',
            payload: JSON.stringify({
              content: 'Long reply with the full story.',
            }),
          })
        );
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
    render(<Harness items={[]} />);

    const slug = await screen.findByText('…[+2194 chars]');
    await user.click(slug);
    expect(await screen.findByText(/full story/)).toBeInTheDocument();
    expect(screen.queryByText('…[+2194 chars]')).not.toBeInTheDocument();
    await user.click(screen.getByText('show less'));
    expect(screen.getByText(/Long reply/)).toBeInTheDocument();
    expect(screen.queryByText(/full story/)).not.toBeInTheDocument();
  });

  it('evicts the previously expanded message when another is expanded', async () => {
    const user = userEvent.setup();
    mockFetch = makeFetch([
      truncatedItem('a1', 'First truncated', 500),
      truncatedItem('a2', 'Second truncated', 600),
    ]);
    render(<Harness items={[]} />);

    await user.click(await screen.findByText('…[+500 chars]'));
    expect(await screen.findByText('FULL CONTENT FOR a1')).toBeInTheDocument();
    await user.click(screen.getByText('…[+600 chars]'));

    await waitFor(() => {
      expect(screen.getByText('FULL CONTENT FOR a2')).toBeInTheDocument();
    });
    // Expanding a2 evicted a1: its content is gone and its slug is back.
    expect(screen.queryByText('FULL CONTENT FOR a1')).not.toBeInTheDocument();
    expect(screen.getByText('…[+500 chars]')).toBeInTheDocument();
  });

  it('re-expanding an evicted message refetches its content', async () => {
    const user = userEvent.setup();
    mockFetch = makeFetch([
      truncatedItem('a1', 'First truncated', 500),
      truncatedItem('a2', 'Second truncated', 600),
    ]);
    render(<Harness items={[]} />);

    await user.click(await screen.findByText('…[+500 chars]'));
    await screen.findByText('FULL CONTENT FOR a1');
    await user.click(screen.getByText('…[+600 chars]'));
    await screen.findByText('FULL CONTENT FOR a2');

    await user.click(screen.getByText('…[+500 chars]'));
    await waitFor(() => {
      expect(
        mockFetch.mock.calls.filter(([url]) => String(url).includes('/content'))
      ).toHaveLength(3);
    });
    await screen.findByText('FULL CONTENT FOR a1');
  });

  it('shows an inline error when the content endpoint fails', async () => {
    const user = userEvent.setup();
    mockFetch = vi.fn().mockImplementation((url: string) => {
      if (!url.startsWith('/api/sessions/agent-1/chat')) {
        return Promise.resolve(jsonResponse(500, {}));
      }
      return Promise.resolve(
        jsonResponse(200, {
          items: [truncatedItem('a1', 'Broken content', 300)],
          hasMore: false,
          oldestCursor: null,
        })
      );
    });
    render(<Harness items={[]} />);
    await user.click(await screen.findByText('…[+300 chars]'));
    expect(
      await screen.findByText(/Full content unavailable/)
    ).toBeInTheDocument();
  });
});

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type {
  ChatFeedItem,
  ChatFeedResponse,
  EventContent,
} from '@/lib/chat-types';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import Markdown from '@/components/markdown';

const INITIAL_LIMIT = 100;
const MAX_RENDERED_ITEMS = 600;
const HISTORY_ENTER_PX = 160;
const BOTTOM_STICK_PX = 80;

const LIFECYCLE_KINDS = new Set([
  'personaChanged',
  'focusChanged',
  'macroExecuted',
  'sessionStarted',
]);

function isLifecycleKind(type: string): boolean {
  return LIFECYCLE_KINDS.has(type);
}

export interface ToolRow {
  /** Event id of the call batch (for content fetch); null for orphan results. */
  callId: string | null;
  resultId: string | null;
  name: string | null;
  args: unknown;
  resultContent: string | null;
}

export interface ChatTurn {
  key: string;
  items: ChatFeedItem[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Server-side truncation suffix (chat-feed.ts PREVIEW_CHARS budget). */
const TRUNCATED_PREVIEW_SUFFIX = /…\[\+(\d+) chars\]$/;

function parseTruncatedPreview(
  preview: string
): { visible: string; hiddenChars: number } | null {
  const match = preview.match(TRUNCATED_PREVIEW_SUFFIX);
  if (!match) return null;
  return {
    visible: preview.slice(0, -match[0].length),
    hiddenChars: Number(match[1]),
  };
}

/** Pull display text out of a raw event payload (content endpoint shape). */
function extractMessageText(payload: string): string {
  const parsed = safeParse(payload);
  if (typeof parsed === 'string') return parsed;
  const obj = asRecord(parsed);
  if (typeof obj?.content === 'string') return obj.content;
  if (typeof obj?.message === 'string') return obj.message;
  return payload;
}

export function buildToolRows(items: ChatFeedItem[]): ToolRow[] {
  const rows: ToolRow[] = [];
  const pending: ToolRow[] = [];
  for (const item of items) {
    if (item.type === 'toolCallBatch') {
      const parsed = asRecord(safeParse(item.preview));
      const calls = Array.isArray(parsed?.toolCalls)
        ? (parsed.toolCalls as Array<Record<string, unknown>>)
        : [];
      if (calls.length === 0) {
        const row: ToolRow = {
          callId: item.id,
          resultId: null,
          name: item.name ?? null,
          args: null,
          resultContent: null,
        };
        rows.push(row);
        pending.push(row);
      } else {
        for (const call of calls) {
          const row: ToolRow = {
            callId: item.id,
            resultId: null,
            name: typeof call.name === 'string' ? call.name : null,
            args: call.arguments ?? null,
            resultContent: null,
          };
          rows.push(row);
          pending.push(row);
        }
      }
    } else if (item.type === 'toolResultBatch') {
      const parsed = asRecord(safeParse(item.preview));
      const results = Array.isArray(parsed?.results)
        ? (parsed.results as Array<Record<string, unknown>>)
        : [];
      if (results.length === 0 && item.hasFull) {
        // Blobbed preview: attach the result to the oldest pending call.
        const orphan = pending.shift();
        if (orphan) {
          orphan.resultId = item.id;
        } else {
          rows.push({
            callId: null,
            resultId: item.id,
            name: item.name ?? null,
            args: null,
            resultContent: null,
          });
        }
      } else if (results.length === 0) {
        rows.push({
          callId: item.id,
          resultId: null,
          name: item.name ?? null,
          args: null,
          resultContent: null,
        });
      } else {
        for (const result of results) {
          const content =
            typeof result.content === 'string' ? result.content : null;
          const orphan = pending.shift() ?? {
            callId: null,
            resultId: null,
            name: item.name ?? null,
            args: null,
            resultContent: null,
          };
          orphan.resultId = item.id;
          if (content !== null) orphan.resultContent = content;
          if (!rows.includes(orphan)) rows.push(orphan);
        }
      }
    } else if (
      item.type !== 'userMessage' &&
      item.type !== 'assistantMessage' &&
      item.type !== 'reasoning' &&
      item.type !== 'error' &&
      item.type !== 'notice' &&
      item.type !== 'compaction' &&
      !isLifecycleKind(item.type)
    ) {
      rows.push({
        callId: item.id,
        resultId: null,
        name: null,
        args: null,
        resultContent: null,
      });
    }
  }
  return rows;
}

function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

function lifecycleLabel(item: ChatFeedItem): string {
  const parsed = asRecord(safeParse(item.preview));
  switch (item.type) {
    case 'personaChanged':
      return `persona → ${String(parsed?.to ?? '?')}`;
    case 'focusChanged':
      return `focus → ${String(parsed?.focus ?? '?')}`;
    case 'macroExecuted':
      return `macro ${String(parsed?.command ?? '')}`;
    case 'sessionStarted':
      return 'session started';
    default:
      return item.type;
  }
}

interface ToolRowViewProps {
  row: ToolRow;
  contentUrlBase: string;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  contentCache: Map<string, EventContent>;
}

function ToolRowView({
  row,
  contentUrlBase,
  authFetch,
  contentCache,
}: ToolRowViewProps) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<EventContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const eventId = row.resultId ?? row.callId;

  const toggle = useCallback(
    async (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen || !eventId || contentCache.has(eventId)) return;
      try {
        const res = await authFetch(`${contentUrlBase}/${eventId}/content`);
        if (!res.ok) {
          setError('content unavailable');
          return;
        }
        const data = (await res.json()) as EventContent;
        contentCache.set(eventId, data);
        setContent(data);
      } catch {
        setError('content unavailable');
      }
    },
    [authFetch, contentCache, contentUrlBase, eventId]
  );

  // Base UI's onOpenChange passes (open, eventDetails) — the first arg
  // is the boolean itself.
  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen: boolean) => void toggle(nextOpen)}
    >
      <div className="flex items-center gap-2">
        <CollapsibleTrigger className="text-xs font-mono flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground cursor-pointer">
          <span>{open ? '▾' : '▸'}</span>
          <span>{'⚙'}</span>
          <span>{row.name ?? 'tool'}</span>
          {row.resultContent !== null && (
            <span className="text-green-600">✓</span>
          )}
        </CollapsibleTrigger>
        {row.args !== null && !open && (
          <span className="text-xs text-muted-foreground font-mono truncate max-w-[40ch]">
            {summarizeArgs(row.args)}
          </span>
        )}
      </div>
      <CollapsibleContent>
        <div className="mt-1 ml-2 border-l-2 border-muted pl-3 py-1 space-y-2">
          {row.args !== null && (
            <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto font-mono whitespace-pre-wrap">
              {summarizeArgs(row.args)}
            </pre>
          )}
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : content ? (
            <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto font-mono whitespace-pre-wrap">
              {content.payload}
            </pre>
          ) : row.resultContent !== null ? (
            <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto font-mono whitespace-pre-wrap">
              {row.resultContent}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">No content.</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface MessageBodyProps {
  item: ChatFeedItem;
  expanded: boolean;
  onToggle: () => void;
  contentUrlBase: string;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  markdown: boolean;
}

function MessageBody({
  item,
  expanded,
  onToggle,
  contentUrlBase,
  authFetch,
  markdown,
}: MessageBodyProps) {
  const truncated = parseTruncatedPreview(item.preview);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Collapse discards the fetched text. The parent's single-expansion
  // policy means at most one message ever holds its full body.
  useEffect(() => {
    if (!expanded) {
      setFullText(null);
      setLoadError(null);
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded || fullText !== null || loadError !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`${contentUrlBase}/${item.id}/content`);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError('Full content unavailable');
          return;
        }
        const data = (await res.json()) as EventContent;
        if (cancelled) return;
        setFullText(extractMessageText(data.payload));
      } catch {
        if (!cancelled) setLoadError('Full content unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, contentUrlBase, expanded, fullText, item.id, loadError]);

  if (!truncated) {
    return <>{markdown ? <Markdown>{item.preview}</Markdown> : item.preview}</>;
  }

  if (expanded && fullText !== null) {
    return (
      <>
        {markdown ? <Markdown>{fullText}</Markdown> : fullText}
        <button
          type="button"
          onClick={onToggle}
          className="text-xs opacity-70 underline decoration-dotted hover:opacity-100 cursor-pointer"
        >
          show less
        </button>
      </>
    );
  }

  return (
    <>
      {markdown ? <Markdown>{truncated.visible}</Markdown> : truncated.visible}
      {expanded &&
        (loadError !== null ? (
          <span className="text-xs text-destructive"> {loadError}</span>
        ) : (
          <span className="text-xs opacity-60"> loading…</span>
        ))}
      <button
        type="button"
        onClick={onToggle}
        className="text-xs opacity-70 underline decoration-dotted hover:opacity-100 cursor-pointer"
        title={`Load ${truncated.hiddenChars} more characters`}
      >
        …[+{truncated.hiddenChars} chars]
      </button>
    </>
  );
}

export function SessionChat({
  sessionId,
  liveItems,
}: {
  sessionId: string;
  liveItems: ChatFeedItem[];
}) {
  const authFetch = useAuthenticatedFetch();
  const contentUrlBase = `/api/sessions/${sessionId}/events`;
  const contentCache = useRef(new Map<string, EventContent>());

  // Single-expansion policy: at most one message shows its full body at a
  // time; expanding another message evicts the previous one. The expanded
  // child discards its fetched text on collapse.
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(
    null
  );
  const toggleExpandedMessage = useCallback((id: string) => {
    setExpandedMessageId(prev => (prev === id ? null : id));
  }, []);

  const [blocks, setBlocks] = useState<ChatFeedItem[][]>([]);
  const [oldestCursor, setOldestCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [atLatest, setAtLatest] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const fetchWindow = useCallback(
    async (before?: string): Promise<ChatFeedResponse | null> => {
      const params = new URLSearchParams({ limit: String(INITIAL_LIMIT) });
      if (before) params.set('before', before);
      try {
        const res = await authFetch(
          `/api/sessions/${sessionId}/chat?${params.toString()}`
        );
        if (!res.ok) return null;
        return (await res.json()) as ChatFeedResponse;
      } catch {
        return null;
      }
    },
    [authFetch, sessionId]
  );

  const resetToLatest = useCallback(async () => {
    const page = await fetchWindow();
    if (!page) return;
    setBlocks([page.items]);
    setOldestCursor(page.oldestCursor);
    setHasMore(page.hasMore);
    setAtLatest(true);
  }, [fetchWindow]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await fetchWindow();
      if (cancelled) return;
      if (page) {
        setBlocks([page.items]);
        setOldestCursor(page.oldestCursor);
        setHasMore(page.hasMore);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchWindow]);

  const loadEarlier = useCallback(async () => {
    if (!oldestCursor || loadingEarlier) return;
    setLoadingEarlier(true);
    const page = await fetchWindow(oldestCursor);
    setLoadingEarlier(false);
    if (!page) return;
    setBlocks(prev => {
      const next = [page.items, ...prev];
      const total = next.reduce((n, b) => n + b.length, 0);
      if (total > MAX_RENDERED_ITEMS && next.length > 1) {
        setAtLatest(false);
        while (
          next.reduce((n, b) => n + b.length, 0) > MAX_RENDERED_ITEMS &&
          next.length > 1
        ) {
          next.pop();
        }
      }
      return next;
    });
    setOldestCursor(page.oldestCursor);
    setHasMore(page.hasMore);
  }, [fetchWindow, loadingEarlier, oldestCursor]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < BOTTOM_STICK_PX;
    if (el.scrollTop < HISTORY_ENTER_PX && hasMore && !loadingEarlier) {
      void loadEarlier();
    }
  }, [hasMore, loadingEarlier, loadEarlier]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [blocks, liveItems]);

  const returnToLatest = useCallback(() => {
    void resetToLatest();
  }, [resetToLatest]);

  const allItems = useMemo(
    () => [...blocks.flat(), ...liveItems],
    [blocks, liveItems]
  );

  const turns = useMemo(() => {
    const result: ChatTurn[] = [];
    for (const item of allItems) {
      const key = item.correlationId ?? `solo-${item.id}`;
      const last = result.at(-1);
      if (last && last.key === key) {
        last.items.push(item);
      } else {
        result.push({ key, items: [item] });
      }
    }
    return result;
  }, [allItems]);

  const renderBody = (item: ChatFeedItem, markdown: boolean) => (
    <MessageBody
      item={item}
      expanded={expandedMessageId === item.id}
      onToggle={() => toggleExpandedMessage(item.id)}
      contentUrlBase={contentUrlBase}
      authFetch={authFetch}
      markdown={markdown}
    />
  );

  if (loading) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Loading conversation...
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="space-y-4 max-h-[65vh] overflow-y-auto pr-1"
      >
        {hasMore && (
          <div className="flex justify-center py-2">
            <Button
              size="sm"
              variant="outline"
              disabled={loadingEarlier}
              onClick={() => void loadEarlier()}
            >
              {loadingEarlier ? 'Loading…' : 'Load earlier'}
            </Button>
          </div>
        )}
        {turns.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p className="text-lg">No messages yet</p>
            <p className="text-sm mt-1">
              The conversation will appear here in real time.
            </p>
          </div>
        ) : (
          turns.map(turn => (
            <div key={turn.key} className="space-y-2">
              {turn.items.map(item =>
                isLifecycleKind(item.type) ? (
                  <div key={item.id} className="flex items-center gap-3 py-1">
                    <div className="flex-1 border-t border-border" />
                    <span className="text-xs text-muted-foreground">
                      {lifecycleLabel(item)}
                    </span>
                    <div className="flex-1 border-t border-border" />
                  </div>
                ) : item.type === 'userMessage' ? (
                  <div key={item.id} className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2 text-sm whitespace-pre-wrap">
                      {renderBody(item, false)}
                    </div>
                  </div>
                ) : item.type === 'assistantMessage' ? (
                  <div key={item.id} className="max-w-[90%]">
                    {renderBody(item, true)}
                  </div>
                ) : item.type === 'reasoning' ? (
                  <p
                    key={item.id}
                    className="text-sm italic text-muted-foreground whitespace-pre-wrap"
                  >
                    {renderBody(item, false)}
                  </p>
                ) : item.type === 'error' ? (
                  <p
                    key={item.id}
                    className="text-sm text-destructive whitespace-pre-wrap"
                  >
                    {renderBody(item, false)}
                  </p>
                ) : item.type === 'notice' || item.type === 'compaction' ? (
                  <p
                    key={item.id}
                    className="text-xs text-muted-foreground whitespace-pre-wrap"
                  >
                    {renderBody(item, false)}
                  </p>
                ) : item.type === 'toolCallBatch' ||
                  item.type === 'toolResultBatch' ? (
                  <ToolRowView
                    key={item.id}
                    row={
                      buildToolRows([item])[0] ?? {
                        callId: item.id,
                        resultId: null,
                        name: null,
                        args: null,
                        resultContent: null,
                      }
                    }
                    contentUrlBase={contentUrlBase}
                    authFetch={authFetch}
                    contentCache={contentCache.current}
                  />
                ) : null
              )}
            </div>
          ))
        )}
      </div>
      {!atLatest && (
        <div className="flex justify-center py-2">
          <Button size="sm" variant="secondary" onClick={returnToLatest}>
            ↓ Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}

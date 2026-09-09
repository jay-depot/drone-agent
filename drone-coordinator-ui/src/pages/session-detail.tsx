import { useCallback, useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { SwarmEvent, SwarmSession, WsEventMessage } from '@/lib/types';
import type { ChatFeedItem } from '@/lib/chat-types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { SessionChat } from '@/components/chat/session-chat';

// A spawned agent registers its swarm session seconds after this page
// mounts, so the first metadata fetch can legitimately 404. A bounded
// retry covers the agent boot window; session-lifecycle events over the
// shared WebSocket cover late registration without a polling loop.
const MAX_SESSION_FETCH_ATTEMPTS = 3;
const SESSION_FETCH_RETRY_MS = 2000;
const SESSION_LIFECYCLE_EVENT_TYPES = new Set([
  'session.created',
  'session.ended',
  'session.processing',
  'session.processed',
  'session.archived',
  'session.restored',
]);

export default function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { subscribe, send } = useWebSocket();
  const authFetch = useAuthenticatedFetch();
  const [events, setEvents] = useState<SwarmEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<SwarmSession | null>(null);
  const localEventIdRef = useRef(0);
  const hasSessionRef = useRef(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [liveChatItems, setLiveChatItems] = useState<ChatFeedItem[]>([]);
  const view = searchParams.get('view') === 'raw' ? 'raw' : 'chat';

  // Fetch session metadata to detect live + interactive (enables chat input).
  const fetchSession = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false;
    try {
      const res = await authFetch(`/api/sessions/${sessionId}`);
      if (res.ok) {
        const data = (await res.json()) as { session: SwarmSession };
        hasSessionRef.current = true;
        setSession(data.session);
        return true;
      }
    } catch {
      // Session metadata is best-effort; the page still renders events.
    }
    return false;
  }, [sessionId, authFetch]);

  // Initial fetch with bounded retry — see MAX_SESSION_FETCH_ATTEMPTS.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    hasSessionRef.current = false;

    const attemptFetch = async (attempt: number): Promise<void> => {
      if (hasSessionRef.current) return;
      const ok = await fetchSession();
      if (cancelled || ok || hasSessionRef.current) return;
      if (attempt + 1 < MAX_SESSION_FETCH_ATTEMPTS) {
        timer = setTimeout(() => {
          void attemptFetch(attempt + 1);
        }, SESSION_FETCH_RETRY_MS);
      }
    };

    void attemptFetch(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, fetchSession]);

  const liveInteractive =
    session !== null &&
    session.status === 'active' &&
    session.interactive === true;

  const sendMessage = async (steer: boolean) => {
    if (!sessionId || !input.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await authFetch(`/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: input.trim(), steer }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setSendError(body?.error ?? 'Failed to send message');
        return;
      }
      setInput('');
    } catch {
      setSendError('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  // Fetch events via REST
  useEffect(() => {
    if (!sessionId) return;

    async function fetchEvents() {
      try {
        const res = await authFetch(`/api/sessions/${sessionId}/events`);
        if (res.ok) {
          const data = await res.json();
          setEvents(data);
        }
      } catch {
        // Handle error
      } finally {
        setLoading(false);
      }
    }
    fetchEvents();
  }, [sessionId, authFetch]);

  // Subscribe to new events via WebSocket
  useEffect(() => {
    if (!sessionId) return;

    const unsub = subscribe('event', msg => {
      const eventMsg = msg as WsEventMessage;
      if (eventMsg.sessionId === sessionId) {
        // The session may register or change state while this page is open
        // (e.g. right after a spawn) — refetch so the chat-input gate and
        // the Live badge stay current without a manual reload.
        if (SESSION_LIFECYCLE_EVENT_TYPES.has(eventMsg.eventType)) {
          void fetchSession();
        }
        // Chat-feed pushes carry trimmed ChatFeedItem payloads; the raw
        // view (legacy endpoints) synthesizes a local SwarmEvent instead.
        const feedItem = eventMsg.payload as ChatFeedItem | undefined;
        if (
          view === 'chat' &&
          feedItem &&
          typeof feedItem === 'object' &&
          typeof (feedItem as ChatFeedItem).id === 'string' &&
          typeof (feedItem as ChatFeedItem).preview === 'string'
        ) {
          setLiveChatItems(prev => [...prev, feedItem]);
        } else {
          setEvents(prev => [
            ...prev,
            {
              id: `ws-${(localEventIdRef.current += 1)}`,
              sessionId: eventMsg.sessionId,
              correlationId: null,
              type: eventMsg.eventType,
              payload:
                typeof eventMsg.payload === 'string'
                  ? eventMsg.payload
                  : JSON.stringify(eventMsg.payload),
              metadata: null,
              createdAt: Date.now(),
            },
          ]);
        }
      }
    });

    // Subscribe to this session using the shared WebSocket
    send({ type: 'subscribe', sessionId });

    return () => {
      unsub();
      send({ type: 'unsubscribe', sessionId });
    };
  }, [sessionId, subscribe, send, fetchSession]);

  // Auto-scroll to latest events
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  const tryFormatJson = (
    text: string | null
  ): { formatted: string; isJson: boolean } => {
    if (!text) return { formatted: '', isJson: false };
    try {
      const parsed = JSON.parse(text);
      return { formatted: JSON.stringify(parsed, null, 2), isJson: true };
    } catch {
      return { formatted: text, isJson: false };
    }
  };

  if (!sessionId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No session ID provided.
      </div>
    );
  }

  const toggleView = () => {
    const next = new URLSearchParams(searchParams);
    if (view === 'chat') {
      next.set('view', 'raw');
    } else {
      next.delete('view');
    }
    setSearchParams(next);
  };

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
          ← Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Session Detail</h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono">
            {sessionId}
          </p>
        </div>
        {liveInteractive ? (
          <Badge variant="default" className="text-xs ml-auto">
            ● Live — Interactive
          </Badge>
        ) : session ? (
          <Badge variant="outline" className="text-xs ml-auto">
            {session.status}
          </Badge>
        ) : null}
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Session Info</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex justify-end mb-2">
            <Button size="sm" variant="outline" onClick={toggleView}>
              {view === 'chat' ? 'Raw log' : 'Chat view'}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Session ID</span>
              <p className="font-mono text-xs mt-0.5">{sessionId}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Events</span>
              <p className="font-medium mt-0.5">{events.length}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {view === 'chat' ? (
        <SessionChat sessionId={sessionId} liveItems={liveChatItems} />
      ) : loading ? (
        <div className="text-center py-12 text-muted-foreground">
          Loading events...
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No events yet</p>
          <p className="text-sm mt-1">
            Events will appear here in real time as the session progresses.
          </p>
        </div>
      ) : (
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {events.map(event => {
            const { formatted, isJson } = tryFormatJson(event.payload);
            return (
              <Collapsible key={event.id}>
                <Card className="border-l-4 border-l-primary/30">
                  <CardHeader className="py-2 px-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CollapsibleTrigger className="h-5 px-1 text-xs cursor-pointer">
                          ▶
                        </CollapsibleTrigger>
                        <Badge variant="secondary" className="text-xs">
                          {event.type}
                        </Badge>
                        {event.correlationId && (
                          <span className="text-xs text-muted-foreground font-mono">
                            corr: {event.correlationId.slice(0, 12)}...
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {formatTime(event.createdAt)}
                      </span>
                    </div>
                  </CardHeader>
                  <CollapsibleContent>
                    <Separator />
                    <CardContent className="py-3 px-4">
                      {isJson ? (
                        <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto whitespace-pre-wrap font-mono">
                          {formatted}
                        </pre>
                      ) : (
                        <p className="text-sm whitespace-pre-wrap">
                          {event.payload}
                        </p>
                      )}
                      {event.metadata && (
                        <div className="mt-2">
                          <span className="text-xs text-muted-foreground">
                            Metadata:
                          </span>
                          <pre className="text-xs bg-muted p-2 rounded-md mt-1 overflow-x-auto font-mono">
                            {event.metadata}
                          </pre>
                        </div>
                      )}
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            );
          })}
          <div ref={eventsEndRef} />
        </div>
      )}

      {sendError && (
        <div className="mt-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {sendError}
        </div>
      )}

      {liveInteractive && (
        <div className="mt-4 flex items-start gap-2">
          <textarea
            className="flex-1 min-h-[60px] rounded-md border bg-background px-3 py-2 text-sm resize-y"
            placeholder="Send a message to this agent…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendMessage(false);
              }
            }}
            disabled={sending}
          />
          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              disabled={!input.trim() || sending}
              onClick={() => void sendMessage(false)}
            >
              {sending ? 'Sending…' : 'Send'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!input.trim() || sending}
              onClick={() => void sendMessage(true)}
              title="Stop the current turn and send this message immediately"
            >
              Stop & Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

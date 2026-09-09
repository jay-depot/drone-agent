import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

interface RegisterBody {
  id: string;
  beaconId: string;
  interactive?: boolean;
}

async function registerSession(body: RegisterBody): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sync/sessions/register',
    payload: body,
  });
  expect(res.statusCode).toBe(201);
}

interface PushEvent {
  id: string;
  sessionId: string;
  correlationId?: string | null;
  type: string;
  payload?: string | null;
  metadata?: string;
  createdAt: number;
}

async function pushEvents(events: PushEvent[]): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sync/events/push',
    payload: { events },
  });
  expect(res.statusCode).toBe(201);
}

function evt(partial: Partial<PushEvent> & { id: string }): PushEvent {
  return {
    sessionId: 'ss-chat',
    type: 'notice',
    payload: JSON.stringify({ kind: 'notice', content: 'hello' }),
    createdAt: 1000,
    ...partial,
  };
}

describe('GET /api/sessions/:id/chat', () => {
  it('returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nope/chat',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns ascending trimmed summaries and excludes noise kinds', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    await pushEvents([
      evt({
        id: 'e1',
        type: 'userMessage',
        payload: JSON.stringify({ kind: 'userMessage', content: 'hi' }),
        correlationId: 'c1',
        createdAt: 1000,
      }),
      evt({ id: 'e2', type: 'roundComplete', payload: null, createdAt: 1001 }),
      evt({
        id: 'e3',
        type: 'toolProgress',
        payload: JSON.stringify({ name: 'x', content: 'chunk' }),
        createdAt: 1002,
      }),
      evt({
        id: 'e4',
        type: 'assistantMessage',
        payload: JSON.stringify({ kind: 'assistantMessage', content: 'hello' }),
        correlationId: 'c1',
        createdAt: 1003,
      }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/chat',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        id: string;
        type: string;
        preview: string;
        hasFull: boolean;
        name?: string;
      }>;
      hasMore: boolean;
      oldestCursor: string | null;
    };
    expect(body.items.map(i => i.id)).toEqual(['e1', 'e4']);
    expect(body.items[0]!.preview).toBe('hi');
    expect(body.items[0]!.hasFull).toBe(false);
    expect(body.hasMore).toBe(false);
    expect(body.oldestCursor).toBe('1000:e1');
  });

  it('summarizes tool batches with names from metadata', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    await pushEvents([
      evt({
        id: 'tc1',
        type: 'toolCallBatch',
        payload: JSON.stringify({
          kind: 'toolCallBatch',
          toolCalls: [{ name: 'file__read', arguments: { path: '/tmp/a.ts' } }],
        }),
        metadata: JSON.stringify({ kind: 'toolCallBatch', name: 'file__read' }),
        correlationId: 'c1',
        createdAt: 1000,
      }),
      evt({
        id: 'tr1',
        type: 'toolResultBatch',
        payload: JSON.stringify({
          kind: 'toolResultBatch',
          results: [{ name: 'file__read', content: 'file contents here' }],
        }),
        metadata: JSON.stringify({
          kind: 'toolResultBatch',
          name: 'file__read',
        }),
        correlationId: 'c1',
        createdAt: 1001,
      }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/chat',
    });
    const body = res.json() as {
      items: Array<{ id: string; name?: string; preview: string }>;
    };
    expect(body.items[0]!.name).toBe('file__read');
    expect(body.items[0]!.preview).toContain('⚙ file__read');
    expect(body.items[0]!.preview).toContain('/tmp/a.ts');
    expect(body.items[1]!.preview).toBe('file contents here');
  });

  it('truncates previews beyond the char budget and flags hasFull', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    const long = 'x'.repeat(2500);
    await pushEvents([
      evt({
        id: 'big',
        type: 'assistantMessage',
        payload: JSON.stringify({ kind: 'assistantMessage', content: long }),
        createdAt: 1000,
      }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/chat',
    });
    const body = res.json() as {
      items: Array<{ preview: string; hasFull: boolean }>;
    };
    expect(body.items[0]!.hasFull).toBe(true);
    expect(body.items[0]!.preview).toContain('…[+');
    expect(body.items[0]!.preview.length).toBeLessThan(1200);
  });

  it('keeps blobbed toolResultBatch previews empty without resolving the blob', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    await pushEvents([
      evt({
        id: 'blobtr',
        type: 'toolResultBatch',
        payload: 'blob:ss-chat/blobtr/deadbeef00000000',
        metadata: JSON.stringify({
          kind: 'toolResultBatch',
          name: 'file__read',
        }),
        createdAt: 1000,
      }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/chat',
    });
    const body = res.json() as {
      items: Array<{ preview: string; hasFull: boolean; name?: string }>;
    };
    expect(body.items[0]!.preview).toBe('');
    expect(body.items[0]!.hasFull).toBe(true);
    expect(body.items[0]!.name).toBe('file__read');
  });

  it('summarizes blobbed message payloads instead of the placeholder', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    const big = 'z'.repeat(20 * 1024);
    await pushEvents([
      evt({
        id: 'bigmsg',
        type: 'userMessage',
        payload: JSON.stringify({ kind: 'userMessage', content: big }),
        createdAt: 1000,
      }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/chat',
    });
    const body = res.json() as {
      items: Array<{ preview: string; hasFull: boolean }>;
    };
    expect(body.items[0]!.hasFull).toBe(true);
    expect(body.items[0]!.preview).toContain('…[+');
    expect(body.items[0]!.preview).not.toContain('expand to load');
    expect(body.items[0]!.preview.length).toBeLessThan(1200);
  });

  it('keeps the placeholder for unresolvable blob refs', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    await pushEvents([
      evt({
        id: 'dangling',
        type: 'userMessage',
        payload: 'blob:ss-chat/dangling/0000000000000000',
        createdAt: 1000,
      }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/chat',
    });
    const body = res.json() as {
      items: Array<{ preview: string; hasFull: boolean }>;
    };
    expect(body.items[0]!.preview).toBe('(large content — expand to load)');
    expect(body.items[0]!.hasFull).toBe(true);
  });

  it('keyset pagination: before cursor returns strictly older events and handles createdAt ties via id', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    await pushEvents([
      evt({ id: 'a', createdAt: 1000 }),
      evt({ id: 'b', createdAt: 1000 }),
      evt({ id: 'c', createdAt: 1000 }),
      evt({ id: 'd', createdAt: 1001 }),
    ]);

    const first = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/chat?limit=2',
    });
    const firstBody = first.json() as {
      items: Array<{ id: string }>;
      hasMore: boolean;
      oldestCursor: string | null;
    };
    // latest-first window, ascending: [c? no — latest 2 are c,d] ascending => [c, d]
    expect(firstBody.items.map(i => i.id)).toEqual(['c', 'd']);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.oldestCursor).toBe('1000:c');

    const second = await app.inject({
      method: 'GET',
      url: `/api/sessions/ss-chat/chat?limit=2&before=${encodeURIComponent(firstBody.oldestCursor!)}`,
    });
    const secondBody = second.json() as {
      items: Array<{ id: string }>;
      hasMore: boolean;
      oldestCursor: string | null;
    };
    expect(secondBody.items.map(i => i.id)).toEqual(['a', 'b']);
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.oldestCursor).toBe('1000:a');
  });

  it('clamps limit into [1, 500]', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    const zero = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/chat?limit=0',
    });
    expect(zero.statusCode).toBe(200);
    const huge = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/chat?limit=99999',
    });
    expect(huge.statusCode).toBe(200);
  });
});

describe('GET /api/sessions/:id/events/:eventId/content', () => {
  it('returns inline payload for non-blob events', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    await pushEvents([
      evt({
        id: 'e1',
        payload: JSON.stringify({ kind: 'notice', content: 'hi' }),
        createdAt: 1000,
      }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/events/e1/content',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; type: string; payload: string };
    expect(body.id).toBe('e1');
    expect(body.type).toBe('notice');
    expect(body.payload).toContain('hi');
  });

  it('resolves blob refs and 404s when the blob is missing', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    // A real blob: push an oversized payload through the push route.
    const large = 'y'.repeat(11 * 1024);
    await pushEvents([evt({ id: 'big', payload: large, createdAt: 1000 })]);

    const ok = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/events/big/content',
    });
    expect(ok.statusCode).toBe(200);
    const okBody = ok.json() as { payload: string };
    expect(okBody.payload).toBe(large);

    // A dangling ref (no file on disk).
    await pushEvents([
      evt({
        id: 'dangling',
        payload: 'blob:ss-chat/dangling/0000000000000000',
        createdAt: 1001,
      }),
    ]);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/events/dangling/content',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'content unavailable' });
  });

  it('404s for unknown event or session', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    await pushEvents([evt({ id: 'e1', createdAt: 1000 })]);

    const noEvent = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/events/zzz/content',
    });
    expect(noEvent.statusCode).toBe(404);
    const noSession = await app.inject({
      method: 'GET',
      url: '/api/sessions/other/events/e1/content',
    });
    expect(noSession.statusCode).toBe(404);
  });
});

describe('deprecated raw event endpoints', () => {
  it('GET /sessions/:id/events and /events/latest carry Deprecation + Sunset headers', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });
    await pushEvents([evt({ id: 'e1', createdAt: 1000 })]);

    const events = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/events',
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers.deprecation).toBe('true');
    expect(events.headers.sunset).toBe('Wed, 01 Jul 2026 00:00:00 GMT');

    const latest = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss-chat/events/latest',
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.headers.deprecation).toBe('true');
    expect(latest.headers.sunset).toBe('Wed, 01 Jul 2026 00:00:00 GMT');
  });
});

describe('WS push-site transform (via /sync/events/push)', () => {
  it('pushes trimmed ChatFeedItem payloads for display kinds', async () => {
    await registerSession({ id: 'ss-chat', beaconId: 'b1' });

    const wsMessages: Array<Record<string, unknown>> = [];
    const { addSubscriber } = await import('../../src/ws-pubsub.js');
    const fakeWs = {
      send: (msg: string) => {
        wsMessages.push(JSON.parse(msg) as Record<string, unknown>);
      },
    };
    const sub = addSubscriber(fakeWs as never);

    await pushEvents([
      evt({
        id: 'live1',
        type: 'assistantMessage',
        payload: JSON.stringify({
          kind: 'assistantMessage',
          content: 'live hello',
        }),
        correlationId: 'c1',
        createdAt: 1000,
      }),
      evt({
        id: 'live2',
        type: 'roundComplete',
        payload: null,
        createdAt: 1001,
      }),
    ]);

    expect(wsMessages).toHaveLength(1);
    expect(wsMessages[0]).toMatchObject({
      type: 'event',
      sessionId: 'ss-chat',
      eventType: 'assistantMessage',
    });
    const item = wsMessages[0]!.payload as Record<string, unknown>;
    expect(item).toMatchObject({
      id: 'live1',
      preview: 'live hello',
      hasFull: false,
    });
    expect(JSON.stringify(wsMessages)).not.toContain('roundComplete');
    expect(typeof sub).toBe('object');
  });
});

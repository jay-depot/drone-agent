import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initDatabase,
  closeDatabase,
  enqueueOutbox,
  dequeueDueOutbox,
  countPendingOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  deleteOutboxEntry,
  OUTBOX_RETRY_BASE_MS,
} from '../src/db/index.js';
import { createOutboxFlusher } from '../src/outbox-flusher.js';
import { createServer, type Server } from 'node:http';

describe('outbox db', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'outbox-db-test-'));
    initDatabase(path.join(dir, 'test.db'));
  });

  afterEach(async () => {
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it('enqueues and dequeues entries in createdAt order', () => {
    const a = enqueueOutbox({
      kind: 'pushEvents',
      endpoint: '/api/sync/events/push',
      method: 'POST',
      body: { events: [{ id: 'e-1' }] },
    });
    const b = enqueueOutbox({
      kind: 'endSwarmSession',
      endpoint: '/api/sync/sessions/s-1',
      method: 'DELETE',
    });
    expect(a.id).toBeTruthy();
    expect(a.attempts).toBe(0);
    expect(a.deliveredAt).toBeNull();
    expect(a.body).toContain('e-1');

    const batch = dequeueDueOutbox(10);
    expect(batch.map(e => e.id)).toEqual([a.id, b.id]);
    expect(countPendingOutbox(true)).toBe(2);
  });

  it('marks entries delivered and clears pending count', () => {
    const entry = enqueueOutbox({
      kind: 'pushPersona',
      endpoint: '/api/personas',
      method: 'POST',
      body: { id: 'p-1' },
    });
    markOutboxDelivered(entry.id);
    const pending = dequeueDueOutbox(10).find(e => e.id === entry.id);
    expect(pending).toBeUndefined();
    expect(countPendingOutbox(true)).toBe(0);
  });

  it('applies exponential backoff between attempts', () => {
    const entry = enqueueOutbox({
      kind: 'pushSkill',
      endpoint: '/api/skills',
      method: 'POST',
      body: { id: 'sk-1' },
    });
    expect(dequeueDueOutbox(10)).toHaveLength(1);

    markOutboxFailed(entry.id, 'status 500');
    expect(dequeueDueOutbox(10)).toHaveLength(0);
    expect(
      dequeueDueOutbox(10, Date.now() + OUTBOX_RETRY_BASE_MS)
    ).toHaveLength(1);

    markOutboxFailed(entry.id, 'status 500');
    expect(
      dequeueDueOutbox(10, Date.now() + OUTBOX_RETRY_BASE_MS)
    ).toHaveLength(0);
    expect(
      dequeueDueOutbox(10, Date.now() + 3 * OUTBOX_RETRY_BASE_MS)
    ).toHaveLength(1);
    expect(countPendingOutbox(true)).toBe(1);
    expect(countPendingOutbox()).toBe(0);
  });

  it('delete removes entries outright', () => {
    const entry = enqueueOutbox({
      kind: 'pushKnowledge',
      endpoint: '/api/sync/knowledge/push',
      method: 'POST',
      body: { id: 'k-1' },
    });
    deleteOutboxEntry(entry.id);
    expect(countPendingOutbox(true)).toBe(0);
  });
});

describe('outbox flusher drain-on-reconnect', () => {
  let dir: string;
  let server: Server;
  const received: Array<{ method: string; url: string; body: string }> = [];
  let failRequests = false;
  const port = 4577;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'outbox-flusher-test-'));
    initDatabase(path.join(dir, 'test.db'));
    if (!server) {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
          body += String(chunk);
        });
        req.on('end', () => {
          received.push({ method: req.method ?? '', url: req.url ?? '', body });
          if (failRequests) {
            res.writeHead(503);
            res.end('unavailable');
          } else {
            res.writeHead(201);
            res.end('{}');
          }
        });
      });
      await new Promise<void>(resolve =>
        server.listen(port, '127.0.0.1', resolve)
      );
    }
    received.length = 0;
    failRequests = false;
  });

  afterEach(async () => {
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it('queues while offline, then drains when the coordinator returns', async () => {
    const flusher = createOutboxFlusher({
      getBaseUrl: () => undefined,
      intervalMs: 3600000,
      maxAttempts: 3,
    });

    enqueueOutbox({
      kind: 'registerSwarmSession',
      endpoint: '/api/sync/sessions/register',
      method: 'POST',
      body: { id: 's-9', beaconId: 'b-1' },
    });
    enqueueOutbox({
      kind: 'pushEvents',
      endpoint: '/api/sync/events/push',
      method: 'POST',
      body: { events: [{ id: 'e-9' }] },
    });

    const offline = await flusher.flushOnce();
    expect(offline).toEqual({
      attempted: 0,
      delivered: 0,
      failed: 0,
      dropped: 0,
    });
    expect(countPendingOutbox(true)).toBe(2);

    failRequests = true;
    const failing = createOutboxFlusher({
      getBaseUrl: () => `http://127.0.0.1:${port}`,
      intervalMs: 3600000,
      maxAttempts: 3,
    });
    const failedRun = await failing.flushOnce();
    expect(failedRun.attempted).toBe(2);
    expect(failedRun.failed).toBe(2);
    expect(countPendingOutbox(true)).toBe(2);

    failRequests = false;
    const recovered = await failing.flushOnce();
    expect(recovered.attempted).toBe(0);
    expect(recovered.delivered).toBe(0);
    expect(countPendingOutbox(true)).toBe(2);
    expect(received.map(r => r.url)).toEqual([
      '/api/sync/sessions/register',
      '/api/sync/events/push',
    ]);

    const retried = createOutboxFlusher({
      getBaseUrl: () => `http://127.0.0.1:${port}`,
      intervalMs: 3600000,
      maxAttempts: 3,
    });
    const drainedLater = await retried.flushOnce();
    void drainedLater;

    const later = dequeueDueOutbox(10, Date.now() + 5 * 60 * 1000);
    expect(later).toHaveLength(2);
  });

  it('delivers fresh entries immediately on first attempt', async () => {
    enqueueOutbox({
      kind: 'registerSwarmSession',
      endpoint: '/api/sync/sessions/register',
      method: 'POST',
      body: { id: 's-fast', beaconId: 'b-1' },
    });
    const flusher = createOutboxFlusher({
      getBaseUrl: () => `http://127.0.0.1:${port}`,
      intervalMs: 3600000,
    });
    const result = await flusher.flushOnce();
    expect(result.delivered).toBe(1);
    expect(countPendingOutbox(true)).toBe(0);
    expect(received.map(r => r.url)).toEqual(['/api/sync/sessions/register']);
  });

  it('treats 404 as delivered for lost-response replays', async () => {
    enqueueOutbox({
      kind: 'endSwarmSession',
      endpoint: '/api/sync/sessions/gone',
      method: 'DELETE',
    });
    const flusher = createOutboxFlusher({
      getBaseUrl: () => `http://127.0.0.1:${port}`,
      intervalMs: 3600000,
    });
    const result = await flusher.flushOnce();
    expect(result.delivered).toBe(1);
    expect(countPendingOutbox(true)).toBe(0);
  });

  it('drops entries that exceed the attempt cap', async () => {
    enqueueOutbox({
      kind: 'pushToolDefinitions',
      endpoint: '/api/sync/tools/push',
      method: 'POST',
      body: { tools: [] },
    });
    failRequests = true;
    const flusher = createOutboxFlusher({
      getBaseUrl: () => `http://127.0.0.1:${port}`,
      intervalMs: 3600000,
      maxAttempts: 1,
    });
    const first = await flusher.flushOnce();
    expect(first.failed).toBe(1);
    expect(first.dropped).toBe(0);

    failRequests = false;
    const second = await flusher.flushOnce();
    expect(second.attempted).toBe(0);
    expect(second.dropped).toBe(0);
    expect(countPendingOutbox(true)).toBe(1);
  });
});

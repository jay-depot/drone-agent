import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initGatewaySchema } from '../src/store/db.js';
import { createScheduledWakeupStore } from '../src/store/gateway-state-store.js';

describe('ScheduledWakeupStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initGatewaySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts and lists a wake-up', () => {
    const store = createScheduledWakeupStore(db);
    store.insert({
      id: 'w1',
      conversationId: 'conv-1',
      note: 'check the soup',
      dueAt: 1_000,
    });
    const rows = store.list('conv-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'w1',
      conversationId: 'conv-1',
      note: 'check the soup',
      dueAt: 1_000,
      attempts: 0,
    });
    expect(rows[0].createdAt).toBeGreaterThan(0);
  });

  it('lists only the requested conversation', () => {
    const store = createScheduledWakeupStore(db);
    store.insert({ id: 'w1', conversationId: 'conv-1', note: 'a', dueAt: 1 });
    store.insert({ id: 'w2', conversationId: 'conv-2', note: 'b', dueAt: 1 });
    expect(store.list('conv-1').map(r => r.id)).toEqual(['w1']);
  });

  it('returns only due rows, oldest first', () => {
    const store = createScheduledWakeupStore(db);
    store.insert({ id: 'w2', conversationId: 'conv-1', note: 'b', dueAt: 200 });
    store.insert({ id: 'w1', conversationId: 'conv-1', note: 'a', dueAt: 100 });
    store.insert({ id: 'w3', conversationId: 'conv-1', note: 'c', dueAt: 300 });
    const rows = store.due('conv-1', 250);
    expect(rows.map(r => r.id)).toEqual(['w1', 'w2']);
  });

  it('breaks due-order ties by created_at', () => {
    const store = createScheduledWakeupStore(db);
    store.insert({
      id: 'first',
      conversationId: 'conv-1',
      note: 'a',
      dueAt: 100,
    });
    store.insert({
      id: 'second',
      conversationId: 'conv-1',
      note: 'b',
      dueAt: 100,
    });
    expect(store.due('conv-1', 100).map(r => r.id)).toEqual([
      'first',
      'second',
    ]);
  });

  it('gets a row by id and returns null when absent', () => {
    const store = createScheduledWakeupStore(db);
    store.insert({ id: 'w1', conversationId: 'conv-1', note: 'a', dueAt: 1 });
    expect(store.get('w1')?.note).toBe('a');
    expect(store.get('nope')).toBeNull();
  });

  it('removes a row', () => {
    const store = createScheduledWakeupStore(db);
    store.insert({ id: 'w1', conversationId: 'conv-1', note: 'a', dueAt: 1 });
    store.remove('w1');
    expect(store.get('w1')).toBeNull();
    expect(store.list('conv-1')).toHaveLength(0);
  });

  it('bumps attempts and returns the new count', () => {
    const store = createScheduledWakeupStore(db);
    store.insert({ id: 'w1', conversationId: 'conv-1', note: 'a', dueAt: 1 });
    expect(store.bumpAttempts('w1')).toBe(1);
    expect(store.bumpAttempts('w1')).toBe(2);
    expect(store.get('w1')?.attempts).toBe(2);
  });

  it('is safe to call initGatewaySchema twice', () => {
    expect(() => initGatewaySchema(db)).not.toThrow();
    const store = createScheduledWakeupStore(db);
    store.insert({ id: 'w1', conversationId: 'conv-1', note: 'a', dueAt: 1 });
    expect(store.list('conv-1')).toHaveLength(1);
  });
});

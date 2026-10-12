import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initGatewaySchema } from '../src/store/db.js';
import {
  createContextSnapshotStore,
  createOutboundLedger,
} from '../src/store/gateway-state-store.js';
import type { DronePortableContextExport } from 'drone-core';

function makeExport(marker: string): DronePortableContextExport {
  return {
    version: 1,
    createdAt: '2026-10-12T00:00:00.000Z',
    session: {
      sourceSessionId: `session-${marker}`,
      turns: [
        {
          messages: [{ role: 'user', content: marker }],
        },
      ],
    },
    tools: [],
    pluginData: {},
  };
}

describe('gateway-state-store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initGatewaySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('ContextSnapshotStore', () => {
    it('round-trips a snapshot', () => {
      const store = createContextSnapshotStore(db);
      const context = makeExport('a');
      store.saveSnapshot('conv-1', context);
      expect(store.getSnapshot('conv-1')).toEqual(context);
    });

    it('overwrites with latest-wins', () => {
      const store = createContextSnapshotStore(db);
      store.saveSnapshot('conv-1', makeExport('a'));
      store.saveSnapshot('conv-1', makeExport('b'));
      expect(store.getSnapshot('conv-1')?.session.sourceSessionId).toBe(
        'session-b'
      );
      // One row per conversation.
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM context_snapshots')
        .get() as { n: number };
      expect(count.n).toBe(1);
    });

    it('returns null for an unknown conversation', () => {
      const store = createContextSnapshotStore(db);
      expect(store.getSnapshot('missing')).toBeNull();
    });

    it('deletes a snapshot', () => {
      const store = createContextSnapshotStore(db);
      store.saveSnapshot('conv-1', makeExport('a'));
      store.deleteSnapshot('conv-1');
      expect(store.getSnapshot('conv-1')).toBeNull();
    });
  });

  describe('OutboundLedgerHandle', () => {
    it('lists entries in insertion order', () => {
      const ledger = createOutboundLedger(db);
      ledger.append('conv-1', { platformRef: '$evt1', text: 'first' });
      ledger.append('conv-1', { text: 'second' });
      const entries = ledger.list('conv-1');
      expect(entries.map(e => e.text)).toEqual(['first', 'second']);
      expect(entries[0].platformRef).toBe('$evt1');
      expect(entries[1].platformRef).toBeUndefined();
    });

    it('scopes rows to their conversation', () => {
      const ledger = createOutboundLedger(db);
      ledger.append('conv-1', { text: 'a' });
      ledger.append('conv-2', { text: 'b' });
      expect(ledger.list('conv-1').map(e => e.text)).toEqual(['a']);
      expect(ledger.list('conv-2').map(e => e.text)).toEqual(['b']);
    });

    it('removes the given ids only', () => {
      const ledger = createOutboundLedger(db);
      ledger.append('conv-1', { text: 'a' });
      ledger.append('conv-1', { text: 'b' });
      const [firstEntry] = ledger.list('conv-1');
      ledger.remove([firstEntry.id]);
      expect(ledger.list('conv-1').map(e => e.text)).toEqual(['b']);
    });

    it('is a no-op for an empty id list', () => {
      const ledger = createOutboundLedger(db);
      ledger.append('conv-1', { text: 'a' });
      ledger.remove([]);
      expect(ledger.list('conv-1')).toHaveLength(1);
    });

    it('is a no-op for a non-existent id', () => {
      const ledger = createOutboundLedger(db);
      ledger.append('conv-1', { text: 'a' });
      ledger.remove([9999]);
      expect(ledger.list('conv-1')).toHaveLength(1);
    });
  });
});

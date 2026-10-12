import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  GatewayConfig,
  ResolvedServiceAdapter,
  ResolvedConversation,
  ControlSurfaceSpec,
  AdapterMessage,
} from '../src/types.js';
import type { SpawnBackend } from '../src/spawn-backend.js';
import { SpawnBackendRegistry } from '../src/spawn-backend-registry.js';
import type {
  ContextSnapshotStore,
  OutboundLedgerEntry,
  OutboundLedgerHandle,
} from '../src/store/gateway-state-store.js';
import { OUTBOUND_LEDGER_PREAMBLE } from '../src/chat-format.js';
import type {
  DronePortableContextExport,
  DroneSessionMessage,
} from 'drone-core';

const DISCLOSURE_MARKER = 'was restored from a prior checkpoint';

const adapterStores = vi.hoisted(() => ({
  snapshotStore: undefined as unknown,
  outboundLedger: undefined as unknown,
}));

vi.mock('../src/adapters/matrix.js', () => ({
  MatrixServiceAdapter: vi.fn().mockImplementation(function (id: string) {
    return {
      id,
      type: 'matrix',
      start: vi.fn(),
      stop: vi.fn(),
      sendMessage: vi.fn(),
      onMessage: vi.fn(),
      snapshotStore: adapterStores.snapshotStore,
      outboundLedger: adapterStores.outboundLedger,
    };
  }),
}));

const { GatewayEngine } = await import('../src/engine.js');

function makeMinimalConfig(
  overrides: Partial<GatewayConfig> = {}
): GatewayConfig {
  return {
    coordinatorUrl: 'http://localhost:8080',
    serviceAdapters: [],
    ...overrides,
  };
}

function makeAdapter(
  overrides: Partial<ResolvedServiceAdapter> = {}
): ResolvedServiceAdapter {
  return {
    id: 'matrix-1',
    type: 'matrix',
    config: { dataPath: '/tmp/acceptance.sqlite' },
    conversations: new Map(),
    ...overrides,
  };
}

function conv(
  surfaces: ControlSurfaceSpec[],
  injectionEnabled?: boolean
): ResolvedConversation {
  return { surfaces, injectionEnabled };
}

type FakeAgent = {
  turns: Array<{ messages: DroneSessionMessage[] }>;
};

/**
 * A fake local backend emulating a drone-agent child: its `importContext`
 * appends the capability's continuation-disclosure turn, and its
 * `exportContext` strips it back out (the real child does both via the
 * portable-context capability, per ADR 249 D5). Records call order so the test
 * can assert restore precedes the first round.
 */
function makeFakeBackend() {
  const agents = new Map<string, FakeAgent>();
  const order: string[] = [];
  let spawns = 0;

  const backend: SpawnBackend = {
    type: 'local',
    spawnSession: vi.fn(async (conversationId: string, personaId: string) => {
      spawns += 1;
      agents.set(conversationId, { turns: [] });
      return {
        conversationId,
        personaId,
        processId: `agent-${spawns}`,
        startedAt: Date.now(),
      };
    }),
    sendMessage: vi.fn(async (session, text: string) => {
      order.push('send');
      const agent = agents.get(session.conversationId);
      agent?.turns.push({ messages: [{ role: 'user', content: text }] });
      agent?.turns.push({
        messages: [{ role: 'assistant', content: 'hello' }],
      });
      return 'hello';
    }),
    importContext: vi.fn(async (session, data: DronePortableContextExport) => {
      order.push('import');
      agents.set(session.conversationId, {
        turns: data.session.turns.map(turn => ({
          messages: turn.messages.map(m => ({ ...m })),
        })),
      });
      agents.get(session.conversationId)?.turns.push({
        messages: [
          {
            role: 'user',
            content: `${DISCLOSURE_MARKER} taken from session ${data.session.sourceSessionId}.`,
          },
        ],
      });
    }),
    exportContext: vi.fn(async session => {
      const agent = agents.get(session.conversationId);
      const turns = (agent?.turns ?? []).filter(
        turn => !turn.messages.some(m => m.content.includes(DISCLOSURE_MARKER))
      );
      return {
        version: 1,
        createdAt: new Date().toISOString(),
        session: { sourceSessionId: session.processId, turns },
        tools: [],
        pluginData: {},
      } satisfies DronePortableContextExport;
    }),
    terminateSession: vi.fn(async () => undefined),
  };

  return { backend, order, spawnCount: () => spawns };
}

function makeSnapshotStore() {
  const snapshots = new Map<string, DronePortableContextExport>();
  const saveSnapshot = vi.fn(
    (id: string, context: DronePortableContextExport) => {
      snapshots.set(id, context);
    }
  );
  const store: ContextSnapshotStore = {
    saveSnapshot,
    getSnapshot: id => snapshots.get(id) ?? null,
    deleteSnapshot: id => void snapshots.delete(id),
  };
  return { store, snapshots, saveSnapshot };
}

function makeLedger() {
  const rows = new Map<string, OutboundLedgerEntry[]>();
  let nextId = 1;
  const ledger: OutboundLedgerHandle = {
    append(conversationId, entry) {
      const list = rows.get(conversationId) ?? [];
      list.push({ id: nextId++, ...entry, createdAt: Date.now() });
      rows.set(conversationId, list);
    },
    list: conversationId => rows.get(conversationId) ?? [],
    remove(ids) {
      for (const [conversationId, list] of rows) {
        rows.set(
          conversationId,
          list.filter(row => !ids.includes(row.id))
        );
      }
    },
  };
  return { ledger, rows };
}

describe('gateway session-continuity acceptance (ADR 249)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores context and shows injected posts after a kill + restart', async () => {
    const { backend, order, spawnCount } = makeFakeBackend();
    const {
      store: snapshotStore,
      snapshots,
      saveSnapshot,
    } = makeSnapshotStore();
    const { ledger, rows } = makeLedger();
    adapterStores.snapshotStore = snapshotStore;
    adapterStores.outboundLedger = ledger;

    const config = makeMinimalConfig({
      serviceAdapters: [
        makeAdapter({
          conversations: new Map([
            [
              '!room:server',
              conv(
                [
                  {
                    type: 'persona-assignment',
                    personaId: 'me',
                    config: { lifecycle: { idleTimeoutMs: 20 } },
                  },
                ],
                true
              ),
            ],
          ]),
        }),
      ],
    });

    const registry = new SpawnBackendRegistry();
    registry.register('local', backend);
    const engine = new GatewayEngine(config, registry);
    await engine.start();

    const matrix = (await import('../src/adapters/matrix.js'))
      .MatrixServiceAdapter as unknown as ReturnType<typeof vi.fn>;
    const adapter = matrix.mock.results.at(-1)?.value as {
      onMessage: ReturnType<typeof vi.fn>;
      sendMessage: ReturnType<typeof vi.fn>;
    };

    const sent: Array<{ conversationId: string; text: string }> = [];
    adapter.sendMessage.mockImplementation(
      async (conversationId: string, text: string) => {
        sent.push({ conversationId, text });
        return '$news1';
      }
    );

    const handler = adapter.onMessage.mock.calls[0][0] as (
      m: AdapterMessage
    ) => void;

    // 1. A message arrives → the agent replies.
    handler({
      adapterId: 'matrix-1',
      conversationId: '!room:server',
      text: 'hi',
      senderName: 'Alice',
      conversationKind: 'room',
    } as AdapterMessage);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // The agent replied "hello" (the inbound turn rode the backend's send).
    expect(sent[0].text).toBe('hello');
    expect(
      (backend.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]
    ).toBe('[- from: Alice]\nhi');

    // 2. A snapshot was exported and saved after the round.
    expect(backend.exportContext).toHaveBeenCalledTimes(1);
    expect(saveSnapshot).toHaveBeenCalledWith(
      '!room:server',
      expect.objectContaining({ version: 1 })
    );
    expect(snapshots.has('!room:server')).toBe(true);

    // 3. The agent is terminated by the idle timeout.
    await vi.waitFor(() =>
      expect(backend.terminateSession).toHaveBeenCalledTimes(1)
    );

    // 4. An external process injects a post while the agent is down.
    await engine.injectMessage('matrix-1', '!room:server', 'weekly news brief');
    expect(rows.get('!room:server')?.[0]).toMatchObject({
      platformRef: '$news1',
      text: 'weekly news brief',
    });

    // The agent is down before the next turn arrives.
    expect(spawnCount()).toBe(1);

    // 5. A new message arrives → fresh agent, restored context, ledger drained.
    order.length = 0;
    handler({
      adapterId: 'matrix-1',
      conversationId: '!room:server',
      text: 'anything new?',
      senderName: 'Bob',
      conversationKind: 'room',
    } as AdapterMessage);
    // sent: [round-1 reply, injected post, round-2 reply] — wait for the
    // round-2 reply (the injected post is posted synchronously by
    // injectMessage above and would make a length-2 wait pass too early).
    await vi.waitFor(() => expect(sent).toHaveLength(3));

    expect(spawnCount()).toBe(2);
    // Restore strictly precedes the first round of the new session.
    expect(order.indexOf('import')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('import')).toBeLessThan(order.indexOf('send'));

    const roundTwoText = (backend.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[1][1] as string;
    expect(roundTwoText.startsWith(OUTBOUND_LEDGER_PREAMBLE)).toBe(true);
    expect(roundTwoText).toContain('[$news1 posted by you]\nweekly news brief');
    expect(roundTwoText).toContain('[- from: Bob]\nanything new?');

    // 6. The injected row was deleted after the successful round.
    expect(rows.get('!room:server')).toEqual([]);

    // 7. The next export carries no continuation-disclosure turn.
    const latest = snapshots.get('!room:server');
    expect(latest).toBeDefined();
    expect(JSON.stringify(latest)).not.toContain(DISCLOSURE_MARKER);

    await engine.stop();
    adapterStores.snapshotStore = undefined;
    adapterStores.outboundLedger = undefined;
  });
});

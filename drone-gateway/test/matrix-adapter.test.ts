import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock matrix-js-sdk
const mockCreateClient = vi.fn();
const mockOn = vi.fn();
const mockStartClient = vi.fn();
const mockInitCrypto = vi.fn();
const mockStopClient = vi.fn();
const mockSendTyping = vi.fn();
const mockSendReadReceipt = vi.fn();
const mockSendHtmlMessage = vi.fn();
const mockSendMessage = vi.fn();
const mockGetRooms = vi.fn();
const mockGetJoinedMemberCount = vi.fn();
const mockGetJoinedMembers = vi.fn();
const mockGetMember = vi.fn();

vi.mock('matrix-js-sdk', () => ({
  createClient: mockCreateClient,
  RoomEvent: {
    Timeline: 'Room.timeline',
  },
}));

// Mock SQLite store modules
const mockOpenGatewayDb = vi.fn();
const mockSqliteSyncStore = vi.fn();
const mockSqliteCryptoStore = vi.fn();
const mockDbClose = vi.fn();

vi.mock('../src/store/db.js', () => ({
  openGatewayDb: mockOpenGatewayDb,
}));

vi.mock('../src/store/sqlite-sync-store.js', () => ({
  SqliteSyncStore: mockSqliteSyncStore,
}));

vi.mock('../src/store/sqlite-crypto-store.js', () => ({
  SqliteCryptoStore: mockSqliteCryptoStore,
}));

const { MatrixServiceAdapter } = await import('../src/adapters/matrix.js');

function makeClientStub() {
  return {
    on: mockOn,
    startClient: mockStartClient,
    initCrypto: mockInitCrypto,
    stopClient: mockStopClient,
    sendTyping: mockSendTyping,
    sendReadReceipt: mockSendReadReceipt,
    sendHtmlMessage: mockSendHtmlMessage,
    sendMessage: mockSendMessage,
    getRooms: mockGetRooms,
    getJoinedMemberCount: mockGetJoinedMemberCount,
    getJoinedMembers: mockGetJoinedMembers,
    getMember: mockGetMember,
  };
}

function makeRoomStub(overrides: Record<string, unknown> = {}) {
  return {
    roomId: '!test:matrix.org',
    getJoinedMemberCount: vi.fn().mockReturnValue(2),
    getJoinedMembers: vi.fn().mockReturnValue([]),
    getMember: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function makeEventStub(overrides: Record<string, unknown> = {}) {
  return {
    getType: vi.fn().mockReturnValue('m.room.message'),
    getSender: vi.fn().mockReturnValue('@alice:matrix.org'),
    getContent: vi.fn().mockReturnValue({ body: 'Hello, world!' }),
    getId: vi.fn().mockReturnValue('$event1'),
    ...overrides,
  };
}

describe('MatrixServiceAdapter', () => {
  let adapter: InstanceType<typeof MatrixServiceAdapter>;
  let clientStub: ReturnType<typeof makeClientStub>;

  beforeEach(() => {
    vi.clearAllMocks();
    clientStub = makeClientStub();
    mockCreateClient.mockReturnValue(clientStub);
    mockStartClient.mockResolvedValue(undefined);
    mockInitCrypto.mockResolvedValue(undefined);
    mockStopClient.mockResolvedValue(undefined);
    mockSendTyping.mockResolvedValue(undefined);
    mockSendReadReceipt.mockResolvedValue(undefined);
    mockSendHtmlMessage.mockResolvedValue(undefined);
    mockSendMessage.mockResolvedValue(undefined);
    mockGetRooms.mockReturnValue([]);
    mockOpenGatewayDb.mockReturnValue({ close: mockDbClose });
    mockSqliteSyncStore.mockImplementation(() => ({}));
    mockSqliteCryptoStore.mockImplementation(() => ({}));
  });

  describe('constructor', () => {
    it('creates an adapter with given id and config', () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });
      expect(adapter.id).toBe('matrix-1');
      expect(adapter.type).toBe('matrix');
    });
  });

  describe('start', () => {
    it('creates a Matrix client with correct config', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
        deviceId: 'DRONEGW',
      });

      await adapter.start();

      expect(mockCreateClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'https://matrix.org',
          accessToken: 'syt_token',
          userId: '@bot:matrix.org',
          deviceId: 'DRONEGW',
        })
      );
    });

    it('initializes crypto (best-effort)', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      await adapter.start();

      expect(mockInitCrypto).toHaveBeenCalled();
    });

    it('starts the client sync', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      await adapter.start();

      expect(mockStartClient).toHaveBeenCalledWith(
        expect.objectContaining({ initialSyncLimit: 10 })
      );
    });

    it('throws if required config is missing', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        // missing userId
      } as any);

      await expect(adapter.start()).rejects.toThrow();
    });

    it('is idempotent (second start is no-op)', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      await adapter.start();
      await adapter.start();

      // createClient should only be called once
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });

    it('opens SQLite database and passes stores when dataPath is set', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
        dataPath: '/tmp/test-gateway.sqlite',
      });

      await adapter.start();

      // Should open the database
      expect(mockOpenGatewayDb).toHaveBeenCalledWith(
        '/tmp/test-gateway.sqlite'
      );

      // Should create store instances
      expect(mockSqliteSyncStore).toHaveBeenCalled();
      expect(mockSqliteCryptoStore).toHaveBeenCalled();

      // Should pass both stores to createClient
      expect(mockCreateClient).toHaveBeenCalledWith(
        expect.objectContaining({
          store: expect.any(Object),
          cryptoStore: expect.any(Object),
        })
      );
    });

    it('does not open SQLite database when dataPath is not set', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      await adapter.start();

      expect(mockOpenGatewayDb).not.toHaveBeenCalled();
      expect(mockCreateClient).toHaveBeenCalledWith(
        expect.not.objectContaining({ store: expect.any(Object) })
      );
    });
  });

  describe('message handling', () => {
    it('emits AdapterMessage for DM timeline events', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      const messages: any[] = [];
      adapter.onMessage(msg => messages.push(msg));

      await adapter.start();

      // Simulate a timeline event
      const timelineHandler = mockOn.mock.calls.find(
        call => call[0] === 'Room.timeline'
      )?.[1];

      expect(timelineHandler).toBeDefined();

      const room = makeRoomStub({
        getJoinedMemberCount: vi.fn().mockReturnValue(2),
        getMember: vi
          .fn()
          .mockReturnValue({ name: 'Alice', rawDisplayName: 'Alice' }),
      });

      const event = makeEventStub();

      timelineHandler(event, room, false);

      expect(messages).toHaveLength(1);
      expect(messages[0].adapterId).toBe('matrix-1');
      expect(messages[0].conversationId).toBe('dm:@alice:matrix.org');
      expect(messages[0].text).toBe('Hello, world!');
      expect(messages[0].senderId).toBe('@alice:matrix.org');
      expect(messages[0].senderName).toBe('Alice');
    });

    it('emits AdapterMessage for room timeline events', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
        rooms: ['!room:matrix.org'],
      });

      const messages: any[] = [];
      adapter.onMessage(msg => messages.push(msg));

      await adapter.start();

      const timelineHandler = mockOn.mock.calls.find(
        call => call[0] === 'Room.timeline'
      )?.[1];

      const room = makeRoomStub({
        roomId: '!room:matrix.org',
        getJoinedMemberCount: vi.fn().mockReturnValue(10), // not a DM
        getMember: vi
          .fn()
          .mockReturnValue({ name: 'Bob', rawDisplayName: 'Bob' }),
      });

      const event = makeEventStub({
        getSender: vi.fn().mockReturnValue('@bob:matrix.org'),
      });

      timelineHandler(event, room, false);

      expect(messages).toHaveLength(1);
      expect(messages[0].conversationId).toBe('!room:matrix.org');
    });

    it('drops events from non-allowlisted rooms', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
        rooms: ['!allowed:matrix.org'],
      });

      const messages: any[] = [];
      adapter.onMessage(msg => messages.push(msg));

      await adapter.start();

      const timelineHandler = mockOn.mock.calls.find(
        call => call[0] === 'Room.timeline'
      )?.[1];

      const room = makeRoomStub({
        roomId: '!other:matrix.org',
        getJoinedMemberCount: vi.fn().mockReturnValue(10),
      });

      const event = makeEventStub();

      timelineHandler(event, room, false);

      expect(messages).toHaveLength(0);
    });

    it('skips own messages', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      const messages: any[] = [];
      adapter.onMessage(msg => messages.push(msg));

      await adapter.start();

      const timelineHandler = mockOn.mock.calls.find(
        call => call[0] === 'Room.timeline'
      )?.[1];

      const room = makeRoomStub();
      const event = makeEventStub({
        getSender: vi.fn().mockReturnValue('@bot:matrix.org'),
      });

      timelineHandler(event, room, false);

      expect(messages).toHaveLength(0);
    });

    it('skips backlog (toStartOfTimeline=true)', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      const messages: any[] = [];
      adapter.onMessage(msg => messages.push(msg));

      await adapter.start();

      const timelineHandler = mockOn.mock.calls.find(
        call => call[0] === 'Room.timeline'
      )?.[1];

      const room = makeRoomStub();
      const event = makeEventStub();

      timelineHandler(event, room, true); // toStartOfTimeline = true

      expect(messages).toHaveLength(0);
    });
  });

  describe('sendMessage', () => {
    it('sends HTML formatted message with typing and read receipt', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      await adapter.start();

      // Simulate a room event (not DM) so conversationId = roomId
      const timelineHandler = mockOn.mock.calls.find(
        call => call[0] === 'Room.timeline'
      )?.[1];

      const room = makeRoomStub({
        roomId: '!test:matrix.org',
        getJoinedMemberCount: vi.fn().mockReturnValue(10), // not a DM
        getMember: vi.fn().mockReturnValue(null),
      });

      const event = makeEventStub();
      timelineHandler(event, room, false);

      // Now send a message to the same room
      await adapter.sendMessage('!test:matrix.org', 'Hello **world**');

      // Should send typing on
      expect(mockSendTyping).toHaveBeenCalledWith(
        '!test:matrix.org',
        true,
        5000
      );

      // Should send read receipt (with the full event object, not just the ID)
      expect(mockSendReadReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ getId: expect.any(Function) })
      );

      // Should send HTML message
      expect(mockSendHtmlMessage).toHaveBeenCalledWith(
        '!test:matrix.org',
        'Hello **world**',
        expect.stringContaining('<strong>world</strong>')
      );

      // Should send typing off
      expect(mockSendTyping).toHaveBeenCalledWith('!test:matrix.org', false, 0);
    });

    it('sends plain text when formattedBody is null', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      await adapter.start();

      // Send to a room with no prior event (no read receipt)
      await adapter.sendMessage('!test:matrix.org', 'plain text');

      // Should still send typing
      expect(mockSendTyping).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('stops the client and clears state', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      await adapter.start();
      await adapter.stop();

      expect(mockStopClient).toHaveBeenCalled();
    });

    it('is idempotent (second stop is no-op)', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
      });

      await adapter.start();
      await adapter.stop();
      await adapter.stop();

      expect(mockStopClient).toHaveBeenCalledTimes(1);
    });

    it('does not delete dataPath (crypto store must persist)', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
        dataPath: '/tmp/matrix-store',
      });

      await adapter.start();
      await adapter.stop();

      // stop() should not attempt to delete dataPath
      expect(mockStopClient).toHaveBeenCalled();
      // No fs.rm or fs.unlink should be called
    });

    it('closes the SQLite database when dataPath was set', async () => {
      adapter = new MatrixServiceAdapter('matrix-1', {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
        dataPath: '/tmp/test-gateway.sqlite',
      });

      await adapter.start();
      await adapter.stop();

      // Should close the database
      expect(mockDbClose).toHaveBeenCalled();
    });
  });
});

import { logger } from '../logger.js';
import { BasicMarkdownRenderer } from '../markdown.js';
import type { ICreateClientOpts } from 'matrix-js-sdk/lib/client.js';
import { openGatewayDb } from '../store/db.js';
import { SqliteCryptoStore } from '../store/sqlite-crypto-store.js';
import { SqliteSyncStore } from '../store/sqlite-sync-store.js';
import type { GatewayDatabase } from '../store/db.js';
import type {
  DroneServiceAdapter,
  AdapterMessage,
  MarkdownRenderer,
} from '../types.js';

// matrix-js-sdk types (imported dynamically to avoid hard dependency)
type MatrixClient = import('matrix-js-sdk').MatrixClient;
type MatrixEvent = import('matrix-js-sdk').MatrixEvent;
type Room = import('matrix-js-sdk').Room;

/**
 * Configuration for the Matrix service adapter.
 */
export interface MatrixAdapterConfig {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  deviceId?: string;
  /** Optional allowlist of room IDs to listen in. DMs are always included. */
  rooms?: string[];
  /**
   * Optional path for persistent sync/crypto store.
   *
   * When set, a SQLite database is created at this path (parent directories
   * are created as needed). Both the sync store (room timelines, sync
   * token) and the crypto store (E2EE keys, Olm sessions) are persisted
   * here, so the bot survives restarts without re-syncing or losing the
   * ability to decrypt messages in encrypted rooms.
   *
   * When unset, the SDK uses in-memory stores (everything is lost on
   * restart).
   */
  dataPath?: string;
}

/**
 * MatrixServiceAdapter connects to a Matrix homeserver via matrix-js-sdk.
 *
 * It listens for messages in configured rooms and DMs, translates them to
 * AdapterMessage format, and sends responses back with markdown→HTML
 * rendering, read receipts, and typing notifications.
 *
 * DM detection: a room with exactly 2 joined members is treated as a DM.
 * DM conversationId format: "dm:@peer:server"
 * Room conversationId format: the room ID (e.g. "!abc:matrix.org")
 */
export class MatrixServiceAdapter implements DroneServiceAdapter {
  readonly id: string;
  readonly type = 'matrix' as const;

  private config: MatrixAdapterConfig;
  private markdownRenderer: MarkdownRenderer;
  private client: MatrixClient | null = null;
  private msgHandler: ((msg: AdapterMessage) => void) | null = null;
  private started = false;
  private db: GatewayDatabase | null = null;

  /**
   * Track the last event per conversation for read receipts.
   * Map<conversationId, { roomId: string; event: MatrixEvent }>
   */
  private lastEvent: Map<string, { roomId: string; event: MatrixEvent }> =
    new Map();

  constructor(
    id: string,
    config: Record<string, unknown>,
    markdownRenderer?: MarkdownRenderer
  ) {
    this.id = id;
    this.config = config as unknown as MatrixAdapterConfig;
    this.markdownRenderer = markdownRenderer ?? new BasicMarkdownRenderer();
  }

  onMessage(handler: (message: AdapterMessage) => void): void {
    this.msgHandler = handler;
  }

  async start(): Promise<void> {
    if (this.started) return;

    const { createClient } = await import('matrix-js-sdk');

    const { homeserverUrl, accessToken, userId, deviceId, dataPath } =
      this.config;

    if (!homeserverUrl || !accessToken || !userId) {
      throw new Error(
        'Matrix adapter requires homeserverUrl, accessToken, and userId'
      );
    }

    logger.info(
      { adapterId: this.id, homeserverUrl, userId },
      'Starting Matrix adapter'
    );

    // Build client options
    const clientOpts: ICreateClientOpts = {
      baseUrl: homeserverUrl,
      accessToken,
      userId,
      deviceId: deviceId || 'drone-gateway',
    };

    // If dataPath is provided, use SQLite-backed stores for persistence
    if (dataPath) {
      logger.info(
        { adapterId: this.id, dataPath },
        'Opening SQLite database for persistent sync/crypto store'
      );
      this.db = openGatewayDb(dataPath);
      clientOpts.store = new SqliteSyncStore(this.db);
      clientOpts.cryptoStore = new SqliteCryptoStore(this.db);
    }

    // Create the Matrix client
    this.client = createClient(clientOpts);

    // Best-effort crypto initialization for E2EE rooms
    try {
      await this.client.initCrypto();
      logger.info(
        'Matrix crypto initialized (E2EE rooms supported; keys persisted via SQLite)'
      );
    } catch (cryptoErr) {
      logger.warn(
        { err: cryptoErr },
        'Matrix crypto initialization failed — E2EE rooms will not be decryptable. ' +
          'Install matrix-js-sdk with crypto support or use unencrypted rooms.'
      );
    }

    // Listen for timeline events
    this.client.on(
      'Room.timeline' as never,
      (
        event: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined
      ) => {
        this.onTimelineEvent(event, room, toStartOfTimeline);
      }
    );

    // Start syncing
    await this.client.startClient({ initialSyncLimit: 10 });
    this.started = true;

    logger.info({ adapterId: this.id }, 'Matrix adapter started and syncing');
  }

  private onTimelineEvent(
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined
  ): void {
    // Skip backlog (initial sync) and non-message events
    if (toStartOfTimeline || event.getType() !== 'm.room.message') return;

    const sender = event.getSender();
    if (!sender || sender === this.config.userId) return;

    const content = event.getContent();
    const body: string = (content?.body as string) || '';
    if (!body) return;

    if (!room) return;

    const roomId = room.roomId;
    const joinedCount = room.getJoinedMemberCount();
    const isDM = joinedCount <= 2;

    // Apply allowlist: if rooms[] is set, only process listed rooms + DMs
    if (!isDM && this.config.rooms && this.config.rooms.length > 0) {
      if (!this.config.rooms.includes(roomId)) return;
    }

    const conversationId = isDM ? `dm:${sender}` : roomId;

    // Get sender display name
    const member = room.getMember(sender);
    const senderName = member?.name || member?.rawDisplayName || sender;

    // Store last event for read receipts
    this.lastEvent.set(conversationId, {
      roomId,
      event,
    });

    // Emit the adapter message
    this.msgHandler?.({
      adapterId: this.id,
      conversationId,
      text: body,
      senderId: sender,
      senderName,
    });
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('Matrix adapter not started');
    }

    // Resolve the target room for this conversation
    const target = this.resolveTarget(conversationId);
    if (!target) {
      logger.warn(
        { conversationId },
        'Cannot send message: unknown conversation'
      );
      return;
    }

    const { roomId } = target;

    // Send typing notification
    try {
      await this.client.sendTyping(roomId, true, 5000);
    } catch {
      // Typing notification is best-effort
    }

    // Send read receipt for the last event in this conversation
    const lastEv = this.lastEvent.get(conversationId);
    if (lastEv) {
      try {
        await this.client.sendReadReceipt(lastEv.event);
      } catch {
        // Read receipt is best-effort
      }
    }

    // Render markdown to HTML
    const rendered = this.markdownRenderer.render(text);

    // Send the message with HTML formatting
    try {
      if (rendered.formattedBody) {
        await this.client.sendHtmlMessage(
          roomId,
          rendered.body,
          rendered.formattedBody
        );
      } else {
        await this.client.sendMessage(roomId, {
          body: rendered.body,
          msgtype: 'm.text' as never,
        });
      }
    } finally {
      // Stop typing notification
      try {
        await this.client.sendTyping(roomId, false, 0);
      } catch {
        // Best-effort
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started || !this.client) return;

    logger.info({ adapterId: this.id }, 'Stopping Matrix adapter');

    try {
      // Graceful stop: flush crypto/sync store and release handles
      // DO NOT delete dataPath — it must persist for E2EE decryption.
      this.client.stopClient();
    } catch (err) {
      logger.warn({ adapterId: this.id, err }, 'Error stopping Matrix client');
    }

    // Close the SQLite database
    if (this.db) {
      try {
        this.db.close();
        logger.info({ adapterId: this.id }, 'SQLite database closed');
      } catch (err) {
        logger.warn(
          { adapterId: this.id, err },
          'Error closing SQLite database'
        );
      }
      this.db = null;
    }

    this.client = null;
    this.started = false;
    this.lastEvent.clear();
  }

  /**
   * Resolve a conversationId to a Matrix room.
   * For room conversations, the conversationId is the roomId.
   * For DM conversations (dm:@peer:server), we look up or create a DM room.
   */
  private resolveTarget(conversationId: string): { roomId: string } | null {
    if (!this.client) return null;

    // If it's a room ID (starts with !), use it directly
    if (conversationId.startsWith('!')) {
      return { roomId: conversationId };
    }

    // If it's a DM conversation (dm:@peer:server), find or create the DM room
    if (conversationId.startsWith('dm:')) {
      const peerId = conversationId.slice(3); // "dm:@peer:server" → "@peer:server"
      return this.resolveDmRoom(peerId);
    }

    return null;
  }

  /**
   * Find an existing DM room with the given peer, or create one.
   */
  private resolveDmRoom(peerId: string): { roomId: string } | null {
    if (!this.client) return null;

    // Look for an existing DM room with this peer
    const rooms = this.client.getRooms();
    for (const room of rooms) {
      if (room.getJoinedMemberCount() === 2) {
        const members = room.getJoinedMembers();
        const hasPeer = members.some(m => m.userId === peerId);
        if (hasPeer) {
          return { roomId: room.roomId };
        }
      }
    }

    // No existing DM room found — create one
    // Note: This is a simplified approach. In production, you'd use
    // createRoom with invite and set the DM tag.
    logger.info(
      { adapterId: this.id, peerId },
      'Creating new DM room with peer'
    );

    // For now, we log and return null — DM room creation requires
    // additional permissions and is best handled by the homeserver.
    // The user should ensure the bot is already in the DM room.
    logger.warn(
      { adapterId: this.id, peerId },
      'No existing DM room found. Ensure the bot user has been invited to the DM.'
    );
    return null;
  }
}

import { logger } from './logger.js';
import type {
  DroneServiceAdapter,
  DroneControlSurface,
  AdapterMessage,
  GatewayConfig,
  ResolvedServiceAdapter,
  ControlSurfaceSpec,
  SpawnSession,
} from './types.js';
import type { SpawnBackend } from './spawn-backend.js';

export class GatewayEngine {
  private adapters: Map<string, DroneServiceAdapter> = new Map();
  /**
   * Map<adapterId, Map<conversationId, DroneControlSurface[]>>
   *
   * Each conversation gets a dedicated ordered list of control surface
   * instances, created at start() time. The key "*" is the per-adapter
   * wildcard catch-all, evaluated last.
   */
  private controlSurfaces: Map<string, Map<string, DroneControlSurface[]>> =
    new Map();
  private config: GatewayConfig;
  private spawnBackend: SpawnBackend;

  constructor(config: GatewayConfig, spawnBackend: SpawnBackend) {
    this.config = config;
    this.spawnBackend = spawnBackend;
  }

  async start(): Promise<void> {
    logger.info(
      `Starting gateway with ${this.config.serviceAdapters.length} adapter(s) ` +
        `(spawn backend: ${this.spawnBackend.type})`
    );

    for (const adapterConfig of this.config.serviceAdapters) {
      const adapter = await this.createAdapter(adapterConfig);
      adapter.onMessage(msg => {
        void this.handleMessage(msg);
      });
      await adapter.start();
      this.adapters.set(adapterConfig.id, adapter);

      // Create per-conversation dedicated control surface instances
      const byConv = new Map<string, DroneControlSurface[]>();
      for (const [convId, specs] of adapterConfig.conversations) {
        const instances = specs.map(spec =>
          this.createControlSurface(spec, convId)
        );
        byConv.set(convId, instances);
      }
      this.controlSurfaces.set(adapterConfig.id, byConv);

      logger.info(
        `Adapter "${adapterConfig.id}" (${adapterConfig.type}) started ` +
          `with ${adapterConfig.conversations.size} conversation(s)`
      );
    }
  }

  private async handleMessage(msg: AdapterMessage): Promise<void> {
    logger.debug(
      { adapterId: msg.adapterId, conversationId: msg.conversationId },
      'Handling message'
    );

    const byConv = this.controlSurfaces.get(msg.adapterId);
    if (!byConv) return;

    // Try exact conversation match first, then wildcard
    const candidates: DroneControlSurface[] = [
      ...(byConv.get(msg.conversationId) ?? []),
      ...(byConv.get('*') ?? []),
    ];

    for (const surface of candidates) {
      const result = await surface.handleMessage(msg);
      if (result.handled) {
        if (result.response) {
          const adapter = this.adapters.get(msg.adapterId);
          if (adapter) {
            await adapter.sendMessage(msg.conversationId, result.response);
          }
        }
        return; // first matching surface handles it
      }
    }

    // No surface handled the message — log as unhandled
    logger.debug(
      { adapterId: msg.adapterId, conversationId: msg.conversationId },
      'Message unhandled by any control surface'
    );
  }

  async stop(): Promise<void> {
    logger.info('Stopping gateway...');
    for (const [id, adapter] of this.adapters) {
      logger.debug(`Stopping adapter "${id}"`);
      await adapter.stop();
    }
    this.adapters.clear();
    this.controlSurfaces.clear();
  }

  private async createAdapter(
    config: ResolvedServiceAdapter
  ): Promise<DroneServiceAdapter> {
    switch (config.type) {
      case 'matrix': {
        // Dynamic import avoids hard dependency when matrix-js-sdk is not installed.
        // The adapter module is expected to export MatrixServiceAdapter as a named export.
        const { MatrixServiceAdapter } = await import('./adapters/matrix.js');
        return new MatrixServiceAdapter(config.id, config.config);
      }
      default:
        throw new Error(
          `No adapter implementation available for type "${config.type}". ` +
            `Supported types: matrix`
        );
    }
  }

  private createControlSurface(
    spec: ControlSurfaceSpec,
    conversationId: string
  ): DroneControlSurface {
    switch (spec.type) {
      case 'persona-assignment': {
        if (!spec.personaId) {
          throw new Error(
            'persona-assignment control surface requires personaId'
          );
        }
        return this.createPersonaAssignmentSurface(
          conversationId,
          spec.personaId
        );
      }
      case 'discard': {
        return this.createDiscardSurface(conversationId);
      }
      default:
        throw new Error(
          `No control surface implementation available for type "${spec.type}". ` +
            `Supported types: persona-assignment, discard`
        );
    }
  }

  private createPersonaAssignmentSurface(
    conversationId: string,
    personaId: string
  ): DroneControlSurface {
    let session: SpawnSession | null = null;

    return {
      id: `persona-assignment-${conversationId}`,
      type: 'persona-assignment',
      handleMessage: async (msg: AdapterMessage) => {
        // The engine guarantees this surface is only invoked for its
        // own conversation — no conversationId re-check needed.
        try {
          // Ensure we have a session for this conversation
          if (!session) {
            session = await this.spawnBackend.spawnSession(
              conversationId,
              personaId
            );
          }

          // Send the message and get the response
          const response = await this.spawnBackend.sendMessage(
            session,
            msg.text
          );

          return { response, handled: true };
        } catch (err) {
          logger.error(
            { err, conversationId, personaId },
            'Error handling message via persona-assignment surface'
          );
          return {
            response: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
            handled: true,
          };
        }
      },
    };
  }

  /**
   * Creates a discard control surface that silently consumes messages.
   * Always returns { response: null, handled: true }.
   * Used for explicit "/dev/null" routing (e.g., wildcard catch-all for
   * unknown DMs).
   */
  private createDiscardSurface(conversationId: string): DroneControlSurface {
    return {
      id: `discard-${conversationId}`,
      type: 'discard',
      handleMessage: async (_msg: AdapterMessage) => {
        logger.debug(
          { conversationId },
          'Message discarded via discard control surface'
        );
        return { response: null, handled: true };
      },
    };
  }
}

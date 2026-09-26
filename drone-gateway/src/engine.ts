import { logger } from './logger.js';
import type {
  DroneServiceAdapter,
  DroneControlSurface,
  AdapterMessage,
  GatewayConfig,
  ResolvedServiceAdapter,
  ControlSurfaceSpec,
} from './types.js';
import type { SpawnBackend } from './spawn-backend.js';
import type { SwarmApi } from './console/swarm-api.js';
import { SurfaceRegistry } from './surfaces/registry.js';
import { registerBuiltInSurfaces } from './surfaces/builtins.js';
import type { SurfaceContext } from './surfaces/types.js';

/**
 * A conversation's instantiated surfaces plus its optional sender allowlist.
 */
type InstantiatedConversation = {
  allowedSenders?: string[];
  surfaces: DroneControlSurface[];
};

/**
 * Map<adapterId, Map<conversationId, InstantiatedConversation>>
 *
 * Each conversation gets a dedicated ordered list of control surface
 * instances, created at start() time. The key "*" is the per-adapter
 * wildcard catch-all, evaluated last.
 */
type AdapterSurfaces = Map<string, InstantiatedConversation>;

function senderAllowed(
  allowed: string[] | undefined,
  senderId: string | undefined
): boolean {
  if (!allowed) return true;
  return senderId !== undefined && allowed.includes(senderId);
}

export class GatewayEngine {
  private adapters: Map<string, DroneServiceAdapter> = new Map();
  private controlSurfaces: Map<string, AdapterSurfaces> = new Map();
  private config: GatewayConfig;
  private spawnBackend: SpawnBackend;
  private swarm: SwarmApi | undefined;
  private surfaceRegistry = new SurfaceRegistry();

  constructor(
    config: GatewayConfig,
    spawnBackend: SpawnBackend,
    swarm?: SwarmApi
  ) {
    this.config = config;
    this.spawnBackend = spawnBackend;
    this.swarm = swarm;
    registerBuiltInSurfaces(this.surfaceRegistry);
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

      const byConv: AdapterSurfaces = new Map();
      for (const [convId, conv] of adapterConfig.conversations) {
        const surfaces = conv.surfaces.map(spec =>
          this.createControlSurface(spec, convId)
        );
        byConv.set(convId, {
          allowedSenders: conv.allowedSenders,
          surfaces,
        });
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

    // A conversation whose allowlist excludes this sender is not a match, so
    // dispatch falls through to the wildcard.
    const exact = byConv.get(msg.conversationId);
    const wildcard = byConv.get('*');
    const candidates: DroneControlSurface[] = [
      ...(exact && senderAllowed(exact.allowedSenders, msg.senderId)
        ? exact.surfaces
        : []),
      ...(wildcard && senderAllowed(wildcard.allowedSenders, msg.senderId)
        ? wildcard.surfaces
        : []),
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
        return;
      }
    }

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
    const factory = this.surfaceRegistry.get(spec.type);
    if (!factory) {
      throw new Error(
        `No control surface implementation available for type "${spec.type}". ` +
          `Supported types: ${this.surfaceRegistry.types().join(', ')}`
      );
    }
    return factory(spec, conversationId, this.surfaceContext());
  }

  private surfaceContext(): SurfaceContext {
    return { spawnBackend: this.spawnBackend, swarm: this.swarm };
  }
}

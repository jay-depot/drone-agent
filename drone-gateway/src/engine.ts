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
  tail: Promise<unknown>;
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

/**
 * Append `fn` to a conversation's serial dispatch chain, returning a promise
 * that settles with `fn`. Guarantees that message N+1 starts only after
 * message N settles, so a conversation never runs two agent turns at once.
 */
function runOnTail<T>(
  conv: InstantiatedConversation,
  fn: () => Promise<T>
): Promise<T> {
  const result = conv.tail.then(fn, fn);
  conv.tail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
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
          tail: Promise.resolve(),
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

    const exactApplies =
      exact !== undefined && senderAllowed(exact.allowedSenders, msg.senderId);
    const wildcardApplies =
      wildcard !== undefined &&
      senderAllowed(wildcard.allowedSenders, msg.senderId);

    const candidates: DroneControlSurface[] = [
      ...(exactApplies && exact ? exact.surfaces : []),
      ...(wildcardApplies && wildcard ? wildcard.surfaces : []),
    ];

    // Serialize dispatch per conversation so two messages for one conversation
    // never run concurrently (which would double-spawn and corrupt the stream).
    const queue = exactApplies ? exact : wildcard;
    if (!queue) return;

    await runOnTail(queue, async () => {
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
    });
  }

  async stop(): Promise<void> {
    logger.info('Stopping gateway...');
    for (const [id, adapter] of this.adapters) {
      logger.debug(`Stopping adapter "${id}"`);
      await adapter.stop();
    }
    this.adapters.clear();

    // Dispose every instantiated surface so spawning surfaces terminate their
    // live agents instead of leaking them past shutdown.
    for (const byConv of this.controlSurfaces.values()) {
      for (const conv of byConv.values()) {
        for (const surface of conv.surfaces) {
          if (surface.dispose) {
            try {
              await surface.dispose();
            } catch (err) {
              logger.warn({ err }, 'Surface dispose failed');
            }
          }
        }
      }
    }
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
    return factory(spec, conversationId, this.surfaceContext(spec));
  }

  /**
   * The beacon a conversation's spawns target: the surface override when
   * present, otherwise the gateway-wide default. Always undefined in local
   * mode, where there is no beacon.
   */
  private resolveTargetBeaconId(spec: ControlSurfaceSpec): string | undefined {
    if (this.spawnBackend.type !== 'coordinator') return undefined;
    const override = spec.config?.targetBeaconId;
    if (typeof override === 'string' && override.trim() !== '') return override;
    return this.config.targetBeaconId;
  }

  private surfaceContext(spec: ControlSurfaceSpec): SurfaceContext {
    const cfg = spec.config ?? {};
    const lifecycle = cfg.lifecycle as { idleTimeoutMs?: number } | undefined;
    return {
      spawnBackend: this.spawnBackend,
      swarm: this.swarm,
      targetBeaconId: this.resolveTargetBeaconId(spec),
      workingDir: cfg.workingDir as string | undefined,
      idleTimeoutMs: lifecycle?.idleTimeoutMs ?? this.config.idleTimeoutMs,
    };
  }
}

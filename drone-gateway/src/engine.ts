import { logger } from './logger.js';
import type {
  DroneServiceAdapter,
  DroneControlSurface,
  AdapterMessage,
  GatewayConfig,
  ServiceAdapterConfig,
  ControlSurfaceConfig,
  SpawnSession,
} from './types.js';
import type { SpawnBackend } from './spawn-backend.js';

export class GatewayEngine {
  private adapters: Map<string, DroneServiceAdapter> = new Map();
  private controlSurfaces: Map<string, DroneControlSurface[]> = new Map();
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
      const adapter = this.createAdapter(adapterConfig);
      adapter.onMessage(msg => {
        void this.handleMessage(msg);
      });
      await adapter.start();
      this.adapters.set(adapterConfig.id, adapter);

      const surfaces = adapterConfig.controlSurfaces.map(cs =>
        this.createControlSurface(cs)
      );
      this.controlSurfaces.set(adapterConfig.id, surfaces);

      logger.info(
        `Adapter "${adapterConfig.id}" (${adapterConfig.type}) started with ${surfaces.length} control surface(s)`
      );
    }
  }

  private async handleMessage(msg: AdapterMessage): Promise<void> {
    logger.debug(
      { adapterId: msg.adapterId, conversationId: msg.conversationId },
      'Handling message'
    );

    const surfaces = this.controlSurfaces.get(msg.adapterId) || [];
    for (const surface of surfaces) {
      const result = await surface.handleMessage(msg);
      if (result.handled) {
        if (result.response) {
          const adapter = this.adapters.get(msg.adapterId);
          if (adapter) {
            await adapter.sendMessage(msg.conversationId, result.response);
          }
        }
        break; // first matching surface handles it
      }
    }
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

  private createAdapter(config: ServiceAdapterConfig): DroneServiceAdapter {
    // Placeholder — actual adapter implementations will be registered here
    // by follow-up phases (4.2 Matrix, 4.6 Telegram, 4.7 Slack).
    // For now, this throws if any adapter type is configured.
    throw new Error(
      `No adapter implementation available for type "${config.type}". ` +
        `Service adapter implementations are not yet built.`
    );
  }

  private createControlSurface(
    config: ControlSurfaceConfig
  ): DroneControlSurface {
    switch (config.type) {
      case 'persona-assignment': {
        if (!config.personaId) {
          throw new Error(
            'persona-assignment control surface requires personaId'
          );
        }
        return this.createPersonaAssignmentSurface(
          config.conversationId,
          config.personaId
        );
      }
      default:
        // Placeholder — other control surface types will be implemented
        // by follow-up phases (4.4 Swarm Console, 4.5 Mention Router).
        throw new Error(
          `No control surface implementation available for type "${config.type}". ` +
            `Control surface implementations are not yet built.`
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
        if (msg.conversationId !== conversationId) {
          return { response: null, handled: false };
        }

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
}

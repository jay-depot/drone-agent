import { logger } from './logger.js';
import { CoordinatorClient } from './coordinator-client.js';
import type {
  DroneServiceAdapter,
  DroneControlSurface,
  AdapterMessage,
  GatewayConfig,
  ServiceAdapterConfig,
  ControlSurfaceConfig,
} from './types.js';

export class GatewayEngine {
  private adapters: Map<string, DroneServiceAdapter> = new Map();
  private controlSurfaces: Map<string, DroneControlSurface[]> = new Map();
  private coordinatorClient: CoordinatorClient;
  private config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.coordinatorClient = new CoordinatorClient(
      config.coordinatorUrl,
      config.coordinatorToken
    );
  }

  async start(): Promise<void> {
    logger.info(
      `Starting gateway with ${this.config.serviceAdapters.length} adapter(s)`
    );

    for (const adapterConfig of this.config.serviceAdapters) {
      const adapter = this.createAdapter(adapterConfig);
      adapter.onMessage((msg) => {
        void this.handleMessage(msg);
      });
      await adapter.start();
      this.adapters.set(adapterConfig.id, adapter);

      const surfaces = adapterConfig.controlSurfaces.map((cs) =>
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
    // Placeholder — actual control surface implementations will be registered here
    // by follow-up phases (4.3 Persona Assignment, 4.4 Swarm Console, 4.5 Mention Router).
    // For now, this throws if any control surface type is configured.
    throw new Error(
      `No control surface implementation available for type "${config.type}". ` +
        `Control surface implementations are not yet built.`
    );
  }
}

import type {
  DroneLlmCapability,
  LlmProtocolDriver,
  DronePlugin,
} from 'drone-core';
import {
  createOllamaProvider,
  discoverOllamaModels,
  ollamaParameterSchema,
} from './driver.js';

type OllamaPluginCapability = {
  driver: LlmProtocolDriver;
};

export const ollamaPlugin: DronePlugin = {
  metadata: {
    id: 'ollama',
    name: 'Ollama',
    version: '0.2.0',
    description:
      'Ollama protocol driver. Inert until a providers config entry selects the "ollama" protocol.',
    defaultEnabled: true,
    dependencies: [{ id: 'llm' }],
  },
  register: async registration => {
    const driver: LlmProtocolDriver = {
      protocolId: 'ollama',
      createProvider: providerConfig =>
        createOllamaProvider({
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          logger: registration.logger,
        }),
      discoverModels: async providerConfig =>
        discoverOllamaModels(providerConfig.baseUrl),
      parameterSchema: ollamaParameterSchema,
    };

    // Offer for direct capability consumers (bootstrap/first-run probing).
    const offered: OllamaPluginCapability = { driver };
    registration.offer<OllamaPluginCapability>(offered);

    const llmCap = registration.request<DroneLlmCapability>('llm');
    if (llmCap) {
      llmCap.registerDriver(driver);
      registration.logger.info('ollama protocol driver registered');
    } else {
      registration.logger.warn(
        'LLM broker not available; ollama driver not registered'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('ollama protocol driver ready');
    });
  },
};

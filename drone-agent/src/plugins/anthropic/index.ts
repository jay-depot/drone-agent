import type {
  DroneLlmCapability,
  LlmProtocolDriver,
  DronePlugin,
} from 'drone-core';
import {
  ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
  anthropicParameterSchema,
  createAnthropicProvider,
  discoverAnthropicModels,
} from './anthropic-driver.js';

export const anthropicPlugin: DronePlugin = {
  metadata: {
    id: 'anthropic',
    name: 'Anthropic',
    version: '0.2.0',
    description:
      'Anthropic Messages protocol driver. Inert until a providers config entry selects the "anthropic" protocol.',
    defaultEnabled: false,
    dependencies: [{ id: 'llm' }],
  },
  register: async registration => {
    const driver: LlmProtocolDriver = {
      protocolId: 'anthropic',
      createProvider: providerConfig =>
        // maxOutputTokens resolution happens broker-side per selected model
        // (declared > discovered > this driver default); the provider falls
        // back to the driver default when the request carries none.
        createAnthropicProvider(
          {
            baseUrl: providerConfig.baseUrl ?? 'https://api.anthropic.com',
            apiKey: providerConfig.apiKey,
            apiVersion: providerConfig.apiVersion ?? '2023-06-01',
            headers: providerConfig.headers,
          },
          () => ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS
        ),
      discoverModels: async () => discoverAnthropicModels(),
      parameterSchema: anthropicParameterSchema,
    };

    registration.offer({ driver });

    const llmCap = registration.request<DroneLlmCapability>('llm');
    if (llmCap) {
      llmCap.registerDriver(driver);
      registration.logger.info('anthropic protocol driver registered');
    } else {
      registration.logger.warn(
        'LLM broker not available; anthropic driver not registered'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('anthropic protocol driver ready');
    });
  },
};

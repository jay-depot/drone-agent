import type {
  DroneLlmCapability,
  LlmProtocolDriver,
  DronePlugin,
} from 'drone-core';
import {
  createOpenAiProvider,
  openAiParameterSchema,
} from '../openai/openai-driver.js';

export const openrouterPlugin: DronePlugin = {
  metadata: {
    id: 'openrouter',
    name: 'OpenRouter',
    version: '0.2.0',
    description:
      'OpenRouter protocol driver (OpenAI-family wire format with reasoning.effort + require_parameters retry). Inert until a providers config entry selects the "openrouter" protocol.',
    defaultEnabled: false,
    dependencies: [{ id: 'llm' }],
  },
  register: async registration => {
    const driver: LlmProtocolDriver = {
      protocolId: 'openrouter',
      createProvider: providerConfig => ({
        chat: createOpenAiProvider(
          'OpenRouter',
          {
            baseUrl: providerConfig.baseUrl ?? 'https://openrouter.ai/api/v1',
            apiKey: providerConfig.apiKey,
            headers: providerConfig.headers,
          },
          {
            reasoningInBody: true,
            toolRoutingRetry: true,
          }
        ).chat,
      }),
      discoverModels: async providerConfig => {
        const { discoverModels } = createOpenAiProvider('OpenRouter', {
          baseUrl: providerConfig.baseUrl ?? 'https://openrouter.ai/api/v1',
          apiKey: providerConfig.apiKey,
          headers: providerConfig.headers,
        });
        return discoverModels();
      },
      parameterSchema: openAiParameterSchema,
    };

    registration.offer({ driver });

    const llmCap = registration.request<DroneLlmCapability>('llm');
    if (llmCap) {
      llmCap.registerDriver(driver);
      registration.logger.info('openrouter protocol driver registered');
    } else {
      registration.logger.warn(
        'LLM broker not available; openrouter driver not registered'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('openrouter protocol driver ready');
    });
  },
};

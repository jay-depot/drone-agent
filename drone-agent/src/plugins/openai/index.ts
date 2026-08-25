import type {
  DroneLlmCapability,
  LlmProtocolDriver,
  DronePlugin,
} from 'drone-core';
import {
  createOpenAiProvider,
  openAiParameterSchema,
} from './openai-driver.js';

export const openaiPlugin: DronePlugin = {
  metadata: {
    id: 'openai',
    name: 'OpenAI',
    version: '0.2.0',
    description:
      'OpenAI Chat Completions protocol driver. Inert until a providers config entry selects the "openai" protocol.',
    defaultEnabled: false,
    dependencies: [{ id: 'llm' }],
  },
  register: async registration => {
    const driver: LlmProtocolDriver = {
      protocolId: 'openai',
      createProvider: providerConfig => ({
        chat: createOpenAiProvider('OpenAI', {
          baseUrl: providerConfig.baseUrl ?? 'https://api.openai.com/v1',
          apiKey: providerConfig.apiKey,
          orgId: providerConfig.orgId,
          headers: providerConfig.headers,
        }).chat,
      }),
      discoverModels: async providerConfig => {
        const { discoverModels } = createOpenAiProvider('OpenAI', {
          baseUrl: providerConfig.baseUrl ?? 'https://api.openai.com/v1',
          apiKey: providerConfig.apiKey,
          orgId: providerConfig.orgId,
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
      registration.logger.info('openai protocol driver registered');
    } else {
      registration.logger.warn(
        'LLM broker not available; openai driver not registered'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('openai protocol driver ready');
    });
  },
};

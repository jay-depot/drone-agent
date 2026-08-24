/**
 * Echo LLM protocol driver.
 *
 * A mock driver that echoes back prompts for deterministic testing. It
 * connects to the echo-llm Docker service or any compatible endpoint.
 */

import type {
  DroneLlmCapability,
  LlmProtocolDriver,
  DronePlugin,
} from 'drone-core';
import { createEchoProvider, echoParameterSchema } from './echo-driver.js';

export const echoPlugin: DronePlugin = {
  metadata: {
    id: 'echo',
    name: 'Echo LLM Provider',
    version: '1.1.0',
    description:
      'Mock LLM protocol driver that echoes prompts for deterministic testing. Inert until a providers config entry selects the "echo" protocol.',
    defaultEnabled: false,
    dependencies: [{ id: 'llm' }],
  },

  async register(registration) {
    const driver: LlmProtocolDriver = {
      protocolId: 'echo',
      createProvider: providerConfig =>
        createEchoProvider({ baseUrl: providerConfig.baseUrl }),
      parameterSchema: echoParameterSchema,
    };

    registration.offer({ driver });

    const llmCap = registration.request<DroneLlmCapability>('llm');
    if (llmCap) {
      llmCap.registerDriver(driver);
      registration.logger.info('echo protocol driver registered');
    } else {
      registration.logger.warn(
        'LLM broker not available; echo driver not registered'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('echo protocol driver ready');
    });
  },
};

export default echoPlugin;

import type {
  DroneContextWindowInfo,
  DroneLlmCapability,
  DroneLlmProvider,
  DroneLlmProviderRegistration,
  DronePlugin,
} from 'drone-core';
import { PRECEDENCE_LLM_PROVIDER } from 'drone-core';
import {
  fromAnthropicResponse,
  toAnthropicRequestParts,
  type AnthropicChatResponse,
} from './anthropic-adapter.js';

export const anthropicPlugin: DronePlugin = {
  metadata: {
    id: 'anthropic',
    name: 'Anthropic',
    version: '0.1.0',
    description: 'Provides cloud chat completion through Anthropic API.',
    defaultEnabled: false,
    dependencies: [{ id: 'llm' }],
  },
  register: async registration => {
    const provider: DroneLlmProvider = {
      getContextWindowInfo: async ({
        model,
      }): Promise<DroneContextWindowInfo | null> => {
        const config = registration.getConfig();
        const modelEntry = config.anthropic.models.find(m => m.id === model);
        if (modelEntry) {
          return {
            model,
            contextWindowTokens: modelEntry.contextWindow,
            source: 'config',
          };
        }
        return {
          model,
          contextWindowTokens: config.session.contextWindowTokens,
          source: 'config',
        };
      },
      chat: async ({ model, messages, tools, reasoningLevel, debug }) => {
        const config = registration.getConfig();
        const apiKey = config.anthropic.apiKey;

        if (!apiKey) {
          throw new Error(
            'Anthropic API key is not configured. Set anthropic.apiKey in your config or use ${ANTHROPIC_API_KEY} environment variable.'
          );
        }

        const body = toAnthropicRequestParts({
          model,
          messages,
          reasoningLevel,
          tools,
          maxTokens: config.session.responseReserveTokens,
        });

        if (debug) {
          console.error(
            `[llm:request] POST ${config.anthropic.baseUrl}/v1/messages`
          );
          console.error(`[llm:request] ${JSON.stringify(body)}`);
        }

        let response: Response;
        try {
          response = await fetch(config.anthropic.baseUrl + '/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': config.anthropic.apiVersion,
            },
            body: JSON.stringify(body),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `Anthropic request failed for model ${model}: ${message}`,
            {
              cause: error,
            }
          );
        }

        if (!response.ok) {
          let errorBody = '';
          try {
            errorBody = await response.text();
          } catch {
            errorBody = '(could not read response body)';
          }
          if (debug) {
            console.error(
              `[llm:response] ${response.status} ${response.statusText}`
            );
            console.error(`[llm:response] ${errorBody}`);
          }
          throw new Error(
            `Anthropic API error (${response.status}): ${errorBody}`
          );
        }

        let data: AnthropicChatResponse;
        try {
          const responseText = await response.text();
          if (debug) {
            console.error(
              `[llm:response] ${response.status} ${response.statusText}`
            );
            console.error(`[llm:response] ${responseText}`);
          }
          data = JSON.parse(responseText) as AnthropicChatResponse;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`Anthropic returned invalid JSON: ${message}`);
        }

        return fromAnthropicResponse(data);
      },
    };

    const llmCap = registration.request<DroneLlmCapability>('llm');
    if (llmCap) {
      const llmRegistration: DroneLlmProviderRegistration = {
        id: 'anthropic',
        precedence: PRECEDENCE_LLM_PROVIDER,
        getProvider: () => provider,
        listModels: async () => {
          const config = registration.getConfig();
          return config.anthropic.models.map(m => m.id);
        },
        getDefaultModel: () => registration.getConfig().anthropic.defaultModel,
      };
      llmCap.registerProvider(llmRegistration);
    } else {
      registration.logger.warn(
        'LLM broker not available; anthropic will not be registered as a provider'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('anthropic provider ready');
    });
  },
};

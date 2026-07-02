import type {
  DroneContextWindowInfo,
  DroneLlmCapability,
  DroneLlmProvider,
  DroneLlmProviderRegistration,
  DronePlugin,
} from 'drone-core';
import { PRECEDENCE_LLM_PROVIDER } from 'drone-core';
import {
  fromOpenAiResponse,
  toOpenAiMessage,
  toOpenAiTools,
  type OpenAiChatRequest,
  type OpenAiChatResponse,
} from '../../shared/openai-compatible.js';

export const openaiPlugin: DronePlugin = {
  metadata: {
    id: 'openai',
    name: 'OpenAI',
    version: '0.1.0',
    description: 'Provides cloud chat completion through OpenAI API.',
    defaultEnabled: false,
    dependencies: [{ id: 'llm' }],
  },
  register: async registration => {
    const provider: DroneLlmProvider = {
      getContextWindowInfo: async ({
        model,
      }): Promise<DroneContextWindowInfo | null> => {
        const config = registration.getConfig();
        const modelEntry = config.openai.models.find(m => m.id === model);
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
      chat: async ({ model, messages, tools }) => {
        const config = registration.getConfig();
        const apiKey = config.openai.apiKey;

        if (!apiKey) {
          throw new Error(
            'OpenAI API key is not configured. Set openai.apiKey in your config or use ${OPENAI_API_KEY} environment variable.'
          );
        }

        const body: OpenAiChatRequest = {
          model,
          messages: messages.map(toOpenAiMessage),
        };

        if (tools && tools.length > 0) {
          body.tools = toOpenAiTools(tools);
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        };
        if (config.openai.orgId) {
          headers['OpenAI-Organization'] = config.openai.orgId;
        }

        let response: Response;
        try {
          response = await fetch(config.openai.baseUrl + '/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`OpenAI request failed for model ${model}: ${message}`, {
            cause: error,
          });
        }

        if (!response.ok) {
          let errorBody = '';
          try {
            errorBody = await response.text();
          } catch {
            errorBody = '(could not read response body)';
          }
          throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
        }

        let data: OpenAiChatResponse;
        try {
          data = (await response.json()) as OpenAiChatResponse;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`OpenAI returned invalid JSON: ${message}`);
        }

        return fromOpenAiResponse(data);
      },
    };

    const llmCap = registration.request<DroneLlmCapability>('llm');
    if (llmCap) {
      const llmRegistration: DroneLlmProviderRegistration = {
        id: 'openai',
        precedence: PRECEDENCE_LLM_PROVIDER,
        getProvider: () => provider,
        listModels: async () => {
          const config = registration.getConfig();
          return config.openai.models.map(m => m.id);
        },
        getDefaultModel: () => registration.getConfig().openai.defaultModel,
      };
      llmCap.registerProvider(llmRegistration);
    } else {
      registration.logger.warn(
        'LLM broker not available; openai will not be registered as a provider'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('openai provider ready');
    });
  },
};
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
} from '../../shared/openai-compatible.js';

type OpenRouterChatRequest = OpenAiChatRequest & {
  provider?: {
    require_parameters?: boolean;
  };
};

type OpenRouterErrorBody = {
  error?: {
    message?: string;
    code?: number;
  };
};

function isToolRoutingError(
  status: number,
  body: OpenRouterErrorBody
): boolean {
  return (
    status === 404 &&
    body.error?.code === 404 &&
    typeof body.error?.message === 'string' &&
    body.error.message.includes('No endpoints found that support tool use')
  );
}

export const openrouterPlugin: DronePlugin = {
  metadata: {
    id: 'openrouter',
    name: 'OpenRouter',
    version: '0.1.0',
    description: 'Provides cloud chat completion through OpenRouter API.',
    defaultEnabled: false,
    dependencies: [{ id: 'llm' }],
  },
  register: async registration => {
    const provider: DroneLlmProvider = {
      getContextWindowInfo: async ({
        model,
      }): Promise<DroneContextWindowInfo | null> => {
        const config = registration.getConfig();
        const modelEntry = config.openrouter.models.find(m => m.id === model);
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
        const apiKey = config.openrouter.apiKey;

        if (!apiKey) {
          throw new Error(
            'OpenRouter API key is not configured. Set openrouter.apiKey in your config or use ${OPENROUTER_API_KEY} environment variable.'
          );
        }

        const bearerToken = 'Bearer ' + apiKey;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: bearerToken,
        };

        const buildBody = (providerHints?: {
          require_parameters: boolean;
        }): OpenRouterChatRequest => {
          const body: OpenRouterChatRequest = {
            model,
            messages: messages.map(toOpenAiMessage),
          };

          if (tools && tools.length > 0) {
            body.tools = toOpenAiTools(tools);
          }

          if (providerHints) {
            body.provider = providerHints;
          }

          return body;
        };

        const doRequest = async (providerHints?: {
          require_parameters: boolean;
        }): Promise<Response> => {
          return fetch(config.openrouter.baseUrl + '/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify(buildBody(providerHints)),
          });
        };

        let response: Response;
        try {
          response = await doRequest();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `OpenRouter request failed for model ${model}: ${message}`,
            { cause: error }
          );
        }

        if (!response.ok) {
          let errorBody: OpenRouterErrorBody = {};
          let errorText = '';
          try {
            errorText = await response.text();
            errorBody = JSON.parse(errorText) as OpenRouterErrorBody;
          } catch {
            // errorText stays as-is if JSON parse fails
          }

          if (isToolRoutingError(response.status, errorBody)) {
            try {
              response = await doRequest({ require_parameters: true });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw new Error(
                `OpenRouter request failed for model ${model}: ${message}`,
                { cause: error }
              );
            }

            if (!response.ok) {
              let retryErrorText = '';
              try {
                retryErrorText = await response.text();
              } catch {
                retryErrorText = '(could not read response body)';
              }
              throw new Error(
                `OpenRouter API error (${response.status}): ${retryErrorText}`
              );
            }
          } else {
            throw new Error(
              `OpenRouter API error (${response.status}): ${errorText}`
            );
          }
        }

        let data;
        try {
          data = await response.json();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`OpenRouter returned invalid JSON: ${message}`);
        }

        return fromOpenAiResponse(data);
      },
    };

    const llmCap = registration.request<DroneLlmCapability>('llm');
    if (llmCap) {
      const llmRegistration: DroneLlmProviderRegistration = {
        id: 'openrouter',
        precedence: PRECEDENCE_LLM_PROVIDER,
        getProvider: () => provider,
        listModels: async () => {
          const config = registration.getConfig();
          return config.openrouter.models.map(m => m.id);
        },
        getDefaultModel: () => registration.getConfig().openrouter.defaultModel,
      };
      llmCap.registerProvider(llmRegistration);
    } else {
      registration.logger.warn(
        'LLM broker not available; openrouter will not be registered as a provider'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('openrouter provider ready');
    });
  },
};

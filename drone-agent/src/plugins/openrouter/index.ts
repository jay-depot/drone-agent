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

type OpenRouterProviderPreferences = {
  require_parameters?: boolean;
};

function isToolRoutingCapabilityError(status: number, errorBody: string): boolean {
  if (status !== 404) {
    return false;
  }

  return /No endpoints found that support tool use/i.test(errorBody);
}

// ── Plugin ──────────────────────────────────────────────────────────

export const openrouterPlugin: DronePlugin = {
  metadata: {
    id: 'openrouter',
    name: 'OpenRouter',
    version: '0.1.0',
    description:
      'Provides cloud chat completion through OpenRouter (OpenAI-compatible API).',
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
        // Fall back to session config
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

        const baseBody: OpenAiChatRequest = {
          model,
          messages: messages.map(toOpenAiMessage),
        };

        if (tools && tools.length > 0) {
          baseBody.tools = toOpenAiTools(tools);
        }

        const requestChatCompletion = async (
          body: OpenAiChatRequest & { provider?: OpenRouterProviderPreferences }
        ): Promise<Response> => {
          try {
            return await fetch(config.openrouter.baseUrl + '/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://drone-agent.dev',
                'X-Title': 'drone-agent',
              },
              body: JSON.stringify(body),
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            throw new Error(
              `OpenRouter request failed for model ${model}: ${message}`,
              { cause: error }
            );
          }
        };

        let response = await requestChatCompletion(baseBody);

        if (!response.ok) {
          let errorBody = '';
          try {
            errorBody = await response.text();
          } catch {
            errorBody = '(could not read response body)';
          }

          const canRetryWithToolRoutingHints =
            tools &&
            tools.length > 0 &&
            isToolRoutingCapabilityError(response.status, errorBody);

          if (canRetryWithToolRoutingHints) {
            registration.logger.warn(
              `OpenRouter routing retry for model ${model}: original request had no tool-capable endpoint` +
                ' (adding provider.require_parameters=true)'
            );

            response = await requestChatCompletion({
              ...baseBody,
              provider: {
                require_parameters: true,
              },
            });

            if (response.ok) {
              let retriedData: OpenAiChatResponse;
              try {
                retriedData = (await response.json()) as OpenAiChatResponse;
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                throw new Error(`OpenRouter returned invalid JSON: ${message}`);
              }
              return fromOpenAiResponse(retriedData);
            }

            let retryErrorBody = '';
            try {
              retryErrorBody = await response.text();
            } catch {
              retryErrorBody = '(could not read response body)';
            }

            throw new Error(
              `OpenRouter API error (${response.status}) after retry with provider hints: ${retryErrorBody}` +
                ` (initial error: ${errorBody})`
            );
          }

          throw new Error(
            `OpenRouter API error (${response.status}): ${errorBody}`
          );
        }

        let data: OpenAiChatResponse;
        try {
          data = (await response.json()) as OpenAiChatResponse;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`OpenRouter returned invalid JSON: ${message}`);
        }

        return fromOpenAiResponse(data);
      },
    };

    // Register with the LLM broker
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

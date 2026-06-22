import type {
  DroneChatMessage,
  DroneChatResponse,
  DroneContextWindowInfo,
  DroneLlmCapability,
  DroneLlmProvider,
  DroneLlmProviderRegistration,
  DronePlugin,
  DroneToolCall,
  DroneToolDescriptor,
} from 'drone-core';
import { PRECEDENCE_LLM_PROVIDER } from 'drone-core';

// ── OpenAI-compatible API types ──────────────────────────────────────

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: OpenAiToolCall[];
};

type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAiTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type OpenAiChatRequest = {
  model: string;
  messages: OpenAiMessage[];
  tools?: OpenAiTool[];
};

type OpenAiChatChoice = {
  message: OpenAiMessage;
  finish_reason: string;
};

type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type OpenAiChatResponse = {
  id: string;
  choices: OpenAiChatChoice[];
  usage?: OpenAiUsage;
};

// ── Message conversion ─────────────────────────────────────────────

function toOpenAiMessage(msg: DroneChatMessage): OpenAiMessage {
  const base: OpenAiMessage = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.toolCallId) {
    base.tool_call_id = msg.toolCallId;
  }
  if (msg.toolName) {
    base.name = msg.toolName;
  }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    base.tool_calls = msg.toolCalls.map(tc => ({
      id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));
  }

  return base;
}

function toOpenAiTools(tools: DroneToolDescriptor[]): OpenAiTool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool.inputSchema ?? {
        type: 'object',
        properties: {},
        additionalProperties: true,
      }) as Record<string, unknown>,
    },
  }));
}

function fromOpenAiResponse(openAi: OpenAiChatResponse): DroneChatResponse {
  const choice = openAi.choices?.[0];
  if (!choice) {
    return { message: '' };
  }

  const result: DroneChatResponse = {
    message: choice.message.content ?? '',
  };

  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    result.toolCalls = choice.message.tool_calls.map(tc => {
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        parsedArgs = {};
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs,
      } satisfies DroneToolCall;
    });
  }

  return result;
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
        const modelEntry = config.openrouter.models.find(
          m => m.id === model
        );
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

        const body: OpenAiChatRequest = {
          model,
          messages: messages.map(toOpenAiMessage),
        };

        if (tools && tools.length > 0) {
          body.tools = toOpenAiTools(tools);
        }

        let response: Response;
        try {
          response = await fetch(config.openrouter.baseUrl + '/chat/completions', {
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

        if (!response.ok) {
          let errorBody = '';
          try {
            errorBody = await response.text();
          } catch {
            errorBody = '(could not read response body)';
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
          throw new Error(
            `OpenRouter returned invalid JSON: ${message}`
          );
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

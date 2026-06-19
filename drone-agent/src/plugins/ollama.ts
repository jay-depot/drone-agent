import { Ollama, type ShowResponse, type ToolCall } from 'ollama';
import type {
  DroneChatMessage,
  DroneChatResponse,
  DroneLlmProvider,
  DronePlugin,
  DroneToolCall,
  DroneToolDescriptor,
} from 'drone-core';

type OllamaPluginCapability = {
  provider: DroneLlmProvider;
};

function toOllamaMessage(message: DroneChatMessage) {
  return {
    role: message.role,
    content: message.content,
    tool_name: message.toolName,
    tool_calls: message.toolCalls?.map(toolCall => ({
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    })),
  };
}

function normalizeToolCall(toolCall: ToolCall): DroneToolCall {
  return {
    id:
      'id' in toolCall && typeof toolCall.id === 'string'
        ? toolCall.id
        : undefined,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments as Record<string, unknown>,
  };
}

function extractContextWindowTokens(showResponse: ShowResponse): number | null {
  const modelInfo = showResponse.model_info;
  const candidateKeys = [
    'general.context_length',
    'llama.context_length',
    'gemma.context_length',
    'qwen2.context_length',
    'context_length',
  ];

  for (const key of candidateKeys) {
    const rawValue =
      modelInfo instanceof Map
        ? modelInfo.get(key)
        : typeof modelInfo === 'object' && modelInfo !== null
          ? (modelInfo as Record<string, unknown>)[key]
          : undefined;

    if (
      typeof rawValue === 'number' &&
      Number.isFinite(rawValue) &&
      rawValue > 0
    ) {
      return rawValue;
    }

    if (typeof rawValue === 'string') {
      const parsed = Number(rawValue);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

function toOllamaTools(tools: DroneToolDescriptor[]) {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? {
        type: 'object' as const,
        properties: {},
        additionalProperties: true,
      },
    },
  }));
}

export const ollamaPlugin: DronePlugin = {
  metadata: {
    id: 'ollama',
    name: 'Ollama',
    version: '0.1.0',
    description: 'Provides local chat completion through Ollama.',
    defaultEnabled: true,
    dependencies: [],
  },
  register: async registration => {
    const provider: DroneLlmProvider = {
      getContextWindowInfo: async ({ model }) => {
        const agentConfig = registration.getConfig();
        const client = new Ollama({ host: agentConfig.ollama.host });

        try {
          const showResponse = await client.show({ model });
          const contextWindowTokens = extractContextWindowTokens(showResponse);
          if (contextWindowTokens) {
            return {
              model,
              contextWindowTokens,
              source: 'provider',
            };
          }
        } catch {
          // Fall back to configured session budget if probing fails.
        }

        return {
          model,
          contextWindowTokens: agentConfig.session.contextWindowTokens,
          source: 'config',
        };
      },
      chat: async ({ model, messages, tools }) => {
        const agentConfig = registration.getConfig();
        const client = new Ollama({ host: agentConfig.ollama.host });
        let response;
        try {
          response = await client.chat({
            model,
            messages: messages.map(toOllamaMessage),
            tools: tools && tools.length > 0 ? toOllamaTools(tools) : undefined,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (message.includes('not found')) {
            throw new Error(
              `Ollama model ${model} is not available at ${agentConfig.ollama.host}. Pull it with "ollama pull ${model}" or update .drone-agent/config.json to use an installed model.`,
              { cause: error }
            );
          }

          throw new Error(
            `Ollama chat request failed for model ${model} at ${agentConfig.ollama.host}: ${message}`,
            { cause: error }
          );
        }

        const normalized: DroneChatResponse = {
          message: response.message.content || '',
        };

        if (
          response.message.tool_calls &&
          response.message.tool_calls.length > 0
        ) {
          normalized.toolCalls =
            response.message.tool_calls.map(normalizeToolCall);
        }

        return normalized;
      },
    };

    registration.offer<OllamaPluginCapability>({ provider });

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('ollama provider ready');
    });
  },
};

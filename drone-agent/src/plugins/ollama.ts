import type { DroneReasoningLevel } from 'drone-core';
import { Ollama, type ShowResponse, type ToolCall } from 'ollama';
import type {
  DroneChatMessage,
  DroneChatResponse,
  DroneLlmCapability,
  DroneLlmProvider,
  DroneLlmProviderRegistration,
  DronePlugin,
  DroneToolCall,
  DroneToolDescriptor,
} from 'drone-core';
import { PRECEDENCE_LLM_PROVIDER } from 'drone-core';

type OllamaPluginCapability = {
  provider: DroneLlmProvider;
  listModels: () => Promise<string[]>;
};

function toOllamaMessage(message: DroneChatMessage) {
  return {
    role: message.role,
    content: message.content,
    images: message.images?.map(img => img.data),
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
  const readModelInfoValue = (key: string): unknown => {
    if (modelInfo instanceof Map) {
      return modelInfo.get(key);
    }
    if (typeof modelInfo === 'object' && modelInfo !== null) {
      return (modelInfo as Record<string, unknown>)[key];
    }
    return undefined;
  };

  const coerceNumber = (rawValue: unknown): number | null => {
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
    return null;
  };

  const generalArchitecture = readModelInfoValue('general.architecture');
  const primaryKeys = [
    'general.context_length',
    'llama.context_length',
    'gemma.context_length',
    'qwen2.context_length',
    'context_length',
  ];
  if (
    typeof generalArchitecture === 'string' &&
    generalArchitecture.trim().length > 0
  ) {
    primaryKeys.unshift(`${generalArchitecture}.context_length`);
  }

  for (const key of primaryKeys) {
    const value = coerceNumber(readModelInfoValue(key));
    if (value !== null) {
      return value;
    }
  }

  // Last resort: scan any "<arch>.context_length" entry — covers new
  // architectures (e.g. deepseek4) that haven't been added to primaryKeys yet.
  if (typeof modelInfo === 'object' && modelInfo !== null) {
    const entries: Iterable<[string, unknown]> =
      modelInfo instanceof Map
        ? modelInfo.entries()
        : Object.entries(modelInfo);
    for (const [key, value] of entries) {
      if (typeof key === 'string' && key.endsWith('.context_length')) {
        const parsed = coerceNumber(value);
        if (parsed !== null) {
          return parsed;
        }
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

/**
 * Map a normalized reasoning level to the Ollama `think` parameter.
 * - `undefined` → omit (use provider default)
 * - `off` → `false` (disable thinking)
 * - `low`/`medium`/`high`/`max` → string level
 * - Any other string (raw pass-through) → pass as-is
 */
function mapReasoningLevel(
  level: DroneReasoningLevel | undefined
): boolean | string | undefined {
  if (level === undefined) return undefined;
  if (level === 'off') return false;
  if (level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  if (level === 'high') return 'high';
  if (level === 'max') return 'max';
  // Raw pass-through: any non-standard string value
  return level;
}

/**
 * @internal Exposed for unit tests. Not part of the public API.
 */
export const __testing = { extractContextWindowTokens };

export const ollamaPlugin: DronePlugin = {
  metadata: {
    id: 'ollama',
    name: 'Ollama',
    version: '0.1.0',
    description: 'Provides local chat completion through Ollama.',
    defaultEnabled: true,
    dependencies: [{ id: 'llm' }],
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
      chat: async ({ model, messages, tools, reasoningLevel, debug }) => {
        const agentConfig = registration.getConfig();
        const client = new Ollama({ host: agentConfig.ollama.host });
        let response;

        if (debug) {
          console.error(`[llm:request] ollama.chat({ model: ${model}, ... })`);
          console.error(
            `[llm:request] messages: ${JSON.stringify(messages.map(toOllamaMessage))}`
          );
        }
        if (debug) {
          console.error(`[llm:response] ${JSON.stringify(response)}`);
        }

        try {
          response = await client.chat({
            model,
            messages: messages.map(toOllamaMessage),
            tools: tools && tools.length > 0 ? toOllamaTools(tools) : undefined,
            think: mapReasoningLevel(reasoningLevel) as
              | boolean
              | 'low'
              | 'medium'
              | 'high'
              | undefined,
          });
        } catch (error) {
          if (debug) {
            console.error(
              `[llm:response] error: ${error instanceof Error ? error.message : String(error)}`
            );
          }

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

        if (response.message.thinking) {
          normalized.reasoning = response.message.thinking;
        }

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

    // Offer the legacy OllamaPluginCapability for backward compat
    registration.offer<OllamaPluginCapability>({
      provider,
      listModels: async () => {
        const agentConfig = registration.getConfig();
        const client = new Ollama({ host: agentConfig.ollama.host });
        const response = await client.list();
        return response.models.map(m => m.name);
      },
    });

    // Register with the LLM broker
    const llmCap = registration.request<DroneLlmCapability>('llm');
    if (llmCap) {
      const llmRegistration: DroneLlmProviderRegistration = {
        id: 'ollama',
        precedence: PRECEDENCE_LLM_PROVIDER,
        getProvider: () => provider,
        listModels: async () => {
          const agentConfig = registration.getConfig();
          const client = new Ollama({ host: agentConfig.ollama.host });
          const response = await client.list();
          return response.models.map(m => m.name);
        },
        getDefaultModel: () => registration.getConfig().ollama.model,
        hasVision: (model: string) => {
          const config = registration.getConfig().ollama;
          if (config.hasVision !== undefined) return config.hasVision;
          // Auto-detect: check model name against known vision model patterns
          const visionPatterns = ['llava', 'bakllava', 'moondream', 'minicpm-v', 'cogvlm', 'qwen-vl', 'qwen3', 'gemma-v', 'gemma4', 'gemini', 'phi-vision', 'minimax', 'kimi', 'mistral'];
          const lower = model.toLowerCase();
          return visionPatterns.some(p => lower.includes(p));
        },
      };
      llmCap.registerProvider(llmRegistration);
    } else {
      registration.logger.warn(
        'LLM broker not available; ollama will not be registered as a provider'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('ollama provider ready');
    });
  },
};

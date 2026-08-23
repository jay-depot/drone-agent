import type {
  DiscoveredModel,
  DroneChatRequest,
  DroneLlmProvider,
} from 'drone-core';
import { Ollama, type ShowResponse } from 'ollama';

/** Reasoning level → Ollama `think` parameter (off disables thinking). */
export function mapReasoningLevel(
  level: string | undefined
): boolean | string | undefined {
  if (level === undefined) return undefined;
  if (level === 'off') return false;
  return level;
}

/**
 * camelCase driver parameters → Ollama `options{}` envelope. Known keys are
 * translated to their wire names; unknown keys pass through verbatim
 * (warned by the broker); `extra` merges silently.
 */
export function buildOllamaOptions(input: {
  parameters?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const wireNames: Record<string, string> = {
    topP: 'top_p',
    topK: 'top_k',
    minP: 'min_p',
    repeatPenalty: 'repeat_penalty',
    numCtx: 'num_ctx',
    numPredict: 'num_predict',
    keepAlive: 'keep_alive',
  };
  for (const [key, value] of Object.entries(input.parameters ?? {})) {
    if (value === undefined || value === null) continue;
    options[wireNames[key] ?? key] = value;
  }
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    options[key] = value;
  }
  return options;
}

export function extractContextWindowTokens(
  showResponse: ShowResponse
): number | null {
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

function readCapabilityFlags(showResponse: ShowResponse): {
  hasVision: boolean;
  supportsTools: boolean;
} {
  const hasCapability = (key: string): boolean => {
    const capabilities: unknown = showResponse.capabilities;
    if (Array.isArray(capabilities)) {
      return capabilities.includes(key);
    }
    if (capabilities instanceof Set) {
      return capabilities.has(key);
    }
    if (capabilities instanceof Map) {
      return Boolean(capabilities.get(key));
    }
    return false;
  };
  return {
    hasVision: hasCapability('vision'),
    supportsTools: hasCapability('tools'),
  };
}

/** Ollama parameter table — validated against by the broker enrichment. */
export const ollamaParameterSchema = {
  parameters: {
    temperature: { type: 'number', description: 'Sampling temperature.' },
    topP: { type: 'number', description: 'Nucleus sampling probability.' },
    topK: { type: 'number', description: 'Top-K sampling size.' },
    minP: { type: 'number', description: 'Minimum probability threshold.' },
    repeatPenalty: { type: 'number' },
    numCtx: {
      type: 'number',
      description: 'Context window size (wire key: num_ctx).',
    },
    numPredict: {
      type: 'number',
      description: 'Max tokens to predict (wire key: num_predict).',
    },
    seed: { type: 'number' },
    stop: { type: 'string[]', description: 'Stop sequences.' },
    keepAlive: {
      type: 'string',
      description: 'Model keep-alive duration (wire key: keep_alive).',
    },
  },
} as const;

/**
 * Build the ollama DroneLlmProvider from a resolved provider entry. The
 * provider reads connection details exclusively from the entry.
 */
export function createOllamaProvider(providerConfig: {
  baseUrl?: string;
  apiKey?: string;
}): DroneLlmProvider {
  const host = providerConfig.baseUrl ?? 'http://127.0.0.1:11434';
  const client = new Ollama({
    host,
    ...(providerConfig.apiKey
      ? { headers: { Authorization: `Bearer ${providerConfig.apiKey}` } }
      : {}),
  });

  return {
    getContextWindowInfo: async ({ model }) => {
      try {
        const showResponse = await client.show({ model });
        const contextWindowTokens = extractContextWindowTokens(showResponse);
        if (contextWindowTokens) {
          return { model, contextWindowTokens, source: 'provider' as const };
        }
      } catch {
        // Fall through to the default-budget fallback below.
      }
      return { model, contextWindowTokens: 32768, source: 'default' as const };
    },
    chat: async ({
      model,
      messages,
      tools,
      reasoningLevel,
      debug,
      parameters,
      extra,
    }: DroneChatRequest) => {
      let response;
      const options = buildOllamaOptions({ parameters, extra });

      // Ollama requires at least one user message in the chat context. When
      // a session contains no user-role message (e.g. all the user turns
      // have been compacted into summaries), prepend a neutral placeholder
      // so the request is still valid.
      const outboundMessages = messages.some(m => m.role === 'user')
        ? messages.map(toOllamaMessage)
        : [
            { role: 'user', content: '(Continuing from summaries)' },
            ...messages.map(toOllamaMessage),
          ];

      if (debug) {
        console.error(`[llm:request] ollama.chat({ model: ${model}, ... })`);
        console.error(
          `[llm:request] messages: ${JSON.stringify(outboundMessages)}`
        );
      }

      try {
        response = await client.chat({
          model,
          messages: outboundMessages,
          tools: tools && tools.length > 0 ? toOllamaTools(tools) : undefined,
          think: mapReasoningLevel(reasoningLevel) as
            | boolean
            | 'low'
            | 'medium'
            | 'high'
            | undefined,
          ...(Object.keys(options).length > 0 ? { options } : {}),
        });
      } catch (error) {
        if (debug) {
          console.error(
            `[llm:response] error: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        const message = error instanceof Error ? error.message : String(error);
        const statusCode = (error as any)?.status_code;
        const statusSuffix = statusCode ? ` (HTTP ${statusCode})` : '';

        if (message.includes('not found')) {
          throw new Error(
            `Ollama model ${model} is not available at ${host}. Pull it with "ollama pull ${model}" or update your providers config to use an installed model.`,
            { cause: error }
          );
        }

        throw new Error(
          `Ollama chat request failed for model ${model} at ${host}: ${message}${statusSuffix}`,
          { cause: error }
        );
      }

      if (debug) {
        console.error(`[llm:response] ${JSON.stringify(response)}`);
      }

      const normalized: {
        message: string;
        reasoning?: string;
        toolCalls?: Array<{
          id?: string;
          name: string;
          arguments: Record<string, unknown>;
        }>;
      } = {
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
}

/**
 * Discover models via `/api/tags` enriched with `/api/show` metadata:
 * capability flags → hasVision/supportsTools; model_info → contextWindow.
 * Individual probe failures degrade that model's metadata to id-only rather
 * than failing discovery.
 */
export async function discoverOllamaModels(
  baseUrl?: string
): Promise<DiscoveredModel[]> {
  const host = baseUrl ?? 'http://127.0.0.1:11434';
  const client = new Ollama({ host });
  const listed = await client.list();
  return Promise.all(
    listed.models.map(async entry => {
      const discovered: DiscoveredModel = { id: entry.name };
      try {
        const show = await client.show({ model: entry.name });
        const contextWindow = extractContextWindowTokens(show);
        if (contextWindow) {
          discovered.contextWindow = contextWindow;
        }
        const flags = readCapabilityFlags(show);
        discovered.hasVision = flags.hasVision;
        discovered.supportsTools = flags.supportsTools;
      } catch {
        // Probe failed — keep the bare id.
      }
      return discovered;
    })
  );
}

function normalizeToolCall(toolCall: {
  function: { name: string; arguments: unknown };
}): { id?: string; name: string; arguments: Record<string, unknown> } {
  return {
    id:
      'id' in toolCall && typeof toolCall.id === 'string'
        ? toolCall.id
        : undefined,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments as Record<string, unknown>,
  };
}

function toOllamaMessage(message: {
  role: string;
  content: string;
  images?: Array<{ data: string }>;
  toolName?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}) {
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

function toOllamaTools(
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: object;
  }>
) {
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

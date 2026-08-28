import {
  DroneLlmError,
  type DiscoveredModel,
  type DroneChatResponse,
} from 'drone-core';
import {
  fromOpenAiResponse,
  toOpenAiMessage,
  toOpenAiTools,
  type OpenAiChatRequest,
  type OpenAiChatResponse,
} from '../../shared/openai-compatible.js';
import {
  isTransientStatus,
  parseRetryAfterMs,
} from '../../runtime/llm-retry.js';

/**
 * Reasoning level → OpenAI-family `reasoning_effort` (off maps to
 * 'minimal' per locked decision; raw values pass through).
 */
export function mapOpenAiReasoningEffort(
  level: string | undefined
): string | undefined {
  if (level === undefined) return undefined;
  if (level === 'off') return 'minimal';
  return level;
}

/** OpenAI Chat Completions parameter table. */
export const openAiParameterSchema = {
  parameters: {
    temperature: { type: 'number' },
    topP: { type: 'number', description: 'Wire key: top_p.' },
    maxTokens: { type: 'number', description: 'Wire key: max_tokens.' },
    frequencyPenalty: {
      type: 'number',
      description: 'Wire key: frequency_penalty.',
    },
    presencePenalty: {
      type: 'number',
      description: 'Wire key: presence_penalty.',
    },
    seed: { type: 'number' },
    stop: { type: 'string[]' },
    user: { type: 'string' },
  },
} as const;

/**
 * camelCase parameters → top-level snake_case Chat Completions fields.
 * Unknown keys pass through verbatim; `extra` merges silently.
 */
export function applyOpenAiParameters(
  body: Record<string, unknown>,
  input: {
    parameters?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  }
): void {
  const wireNames: Record<string, string> = {
    topP: 'top_p',
    maxTokens: 'max_tokens',
    frequencyPenalty: 'frequency_penalty',
    presencePenalty: 'presence_penalty',
  };
  for (const [key, value] of Object.entries(input.parameters ?? {})) {
    if (value === undefined || value === null) continue;
    body[wireNames[key] ?? key] = value;
  }
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    body[key] = value;
  }
}

function coercePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

/**
 * Take-if-present mapping of an OpenAI-compatible /models entry into
 * DiscoveredModel metadata. OpenRouter's catalog carries context_length,
 * top_provider.max_completion_tokens (nullable), and architecture modality
 * info; vanilla OpenAI returns bare ids and degrades to id-only entries.
 * Anything absent or non-numeric is simply omitted.
 */
export function mapDiscoveredModel(entry: {
  id: string;
  context_length?: unknown;
  top_provider?: { max_completion_tokens?: unknown } | null;
  architecture?: { input_modalities?: unknown } | null;
}): DiscoveredModel {
  const discovered: DiscoveredModel = { id: entry.id };

  const contextLength = coercePositiveNumber(entry.context_length);
  if (contextLength !== null) {
    discovered.contextWindow = contextLength;
  }

  const maxCompletion = coercePositiveNumber(
    entry.top_provider?.max_completion_tokens
  );
  if (maxCompletion !== null) {
    discovered.maxOutputTokens = maxCompletion;
  }

  const inputModalities = entry.architecture?.input_modalities;
  if (
    Array.isArray(inputModalities) &&
    inputModalities.map(modality => String(modality)).includes('image')
  ) {
    discovered.hasVision = true;
  }

  return discovered;
}

export type OpenAiDriverConfig = {
  baseUrl?: string;
  apiKey?: string;
  orgId?: string;
  headers?: Record<string, string>;
};

function buildHeaders(config: OpenAiDriverConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...config.headers,
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  if (config.orgId) {
    headers['OpenAI-Organization'] = config.orgId;
  }
  return headers;
}

export function createOpenAiProvider(
  label: string,
  config: OpenAiDriverConfig,
  options: {
    /** OpenRouter nests reasoning under `body.reasoning`. */
    reasoningInBody?: boolean;
    /** OpenRouter's require_parameters retry on tool-routing 404s. */
    toolRoutingRetry?: boolean;
  } = {}
) {
  const baseUrl = config.baseUrl ?? '';
  const buildBody = (
    request: import('drone-core').DroneChatRequest,
    providerHints?: { require_parameters: boolean }
  ): OpenAiChatRequest => {
    const body: OpenAiChatRequest & Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOpenAiMessage),
    };

    const effort = mapOpenAiReasoningEffort(request.reasoningLevel);
    if (effort !== undefined) {
      if (options.reasoningInBody) {
        body.reasoning = { effort };
      } else {
        body.reasoning_effort = effort;
      }
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = toOpenAiTools(request.tools);
    }

    applyOpenAiParameters(body, request);

    if (providerHints) {
      body.provider = providerHints;
    }

    return body as OpenAiChatRequest;
  };

  const doFetch = async (body: OpenAiChatRequest): Promise<Response> => {
    return fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(body),
    });
  };

  return {
    chat: async (
      request: import('drone-core').DroneChatRequest
    ): Promise<DroneChatResponse> => {
      const { model, debug } = request;
      if (!config.apiKey) {
        throw new Error(
          `${label} API key is not configured. Set providers.<id>.apiKey in your config or use a \${VAR} environment reference.`
        );
      }

      let body = buildBody(request);
      if (debug) {
        console.error(`[llm:request] POST ${baseUrl}/chat/completions`);
        console.error(`[llm:request] ${JSON.stringify(body)}`);
      }

      let response: Response;
      try {
        response = await doFetch(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DroneLlmError(
          `${label} request failed for model ${model}: ${message}`,
          { retryable: false }
        );
      }

      if (!response.ok && options.toolRoutingRetry) {
        const retry = await maybeToolRoutingRetry(
          response,
          request,
          buildBody,
          doFetch,
          debug
        );
        if (retry !== undefined) {
          response = retry.response;
          body = retry.body;
        }
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
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get('retry-after') ?? undefined
        );
        throw new DroneLlmError(
          `${label} API error (${response.status}): ${errorBody}`,
          {
            status: response.status,
            retryAfterMs,
            retryable: isTransientStatus(response.status),
            body: errorBody,
          }
        );
      }

      let data: OpenAiChatResponse;
      try {
        const responseText = await response.text();
        if (debug) {
          console.error(
            `[llm:response] ${response.status} ${response.statusText}`
          );
          console.error(`[llm:response] ${responseText}`);
        }
        data = JSON.parse(responseText) as OpenAiChatResponse;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DroneLlmError(`${label} returned invalid JSON: ${message}`, {
          retryable: false,
        });
      }

      return fromOpenAiResponse(data);
    },
    /**
     * Minimal discovery over `/models` returning ids only (no reliable
     * metadata contract across OpenAI-compatible gateways).
     */
    discoverModels: async (): Promise<DiscoveredModel[]> => {
      if (!baseUrl) {
        throw new Error(
          `${label} discovery requires providers.<id>.baseUrl to be set.`
        );
      }
      const response = await fetch(baseUrl + '/models', {
        headers: buildHeaders(config),
      });
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get('retry-after') ?? undefined
        );
        throw new DroneLlmError(
          `${label} model discovery failed (${response.status}).`,
          {
            status: response.status,
            retryAfterMs,
            retryable: isTransientStatus(response.status),
          }
        );
      }
      const data = (await response.json()) as {
        data?: Array<Record<string, unknown>>;
      };
      return (data.data ?? [])
        .filter(
          (entry): entry is Record<string, unknown> & { id: string } =>
            typeof entry.id === 'string'
        )
        .map(entry => mapDiscoveredModel(entry));
    },
  };
}

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

async function maybeToolRoutingRetry(
  failedResponse: Response,
  request: import('drone-core').DroneChatRequest,
  buildBody: (
    request: import('drone-core').DroneChatRequest,
    providerHints?: { require_parameters: boolean }
  ) => OpenAiChatRequest,
  doFetch: (body: OpenAiChatRequest) => Promise<Response>,
  debug?: boolean
): Promise<{ response: Response; body: OpenAiChatRequest } | undefined> {
  let errorBody: OpenRouterErrorBody = {};
  let errorText = '';
  try {
    errorText = await failedResponse.text();
    errorBody = JSON.parse(errorText) as OpenRouterErrorBody;
  } catch {
    // errorText stays as-is if JSON parse fails
  }

  if (!isToolRoutingError(failedResponse.status, errorBody)) {
    return undefined;
  }

  const retryBody = buildBody(request, { require_parameters: true });
  if (debug) {
    console.error('[llm:request] retrying with provider.require_parameters');
  }
  const response = await doFetch(retryBody);
  return { response, body: retryBody };
}

import {
  DroneLlmError,
  type DiscoveredModel,
  type DroneLlmProvider,
} from 'drone-core';
import {
  fromAnthropicResponse,
  toAnthropicRequestParts,
} from './anthropic-adapter.js';
import {
  isTransientStatus,
  parseRetryAfterMs,
} from '../../runtime/llm-retry.js';

/** Driver default when a provider/model declares no maxOutputTokens. */
export const ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Reasoning level → thinking budget as a fraction of maxOutputTokens
 * (low≈10%, medium/high/max≈50%, off/undefined → no thinking block).
 */
export function anthropicThinkingBudget(
  level: string | undefined,
  maxOutputTokens: number
): number | undefined {
  if (level === undefined || level === 'off') return undefined;
  if (level === 'low') return Math.floor(maxOutputTokens * 0.1);
  return Math.floor(maxOutputTokens * 0.5);
}

export const anthropicParameterSchema = {
  parameters: {
    temperature: { type: 'number' },
    topP: { type: 'number', description: 'Wire key: top_p.' },
    topK: { type: 'number', description: 'Wire key: top_k.' },
    stopSequences: {
      type: 'string[]',
      description: 'Wire key: stop_sequences.',
    },
  },
} as const;

export type AnthropicDriverConfig = {
  baseUrl?: string;
  apiKey?: string;
  apiVersion?: string;
  headers?: Record<string, string>;
};

/**
 * Build the Anthropic DroneLlmProvider from a resolved provider entry.
 *
 * Wire `max_tokens` comes from resolved `maxOutputTokens` metadata (driver
 * default when absent) instead of borrowing `session.responseReserveTokens`
 * — this is the one intentional behavior change of this refactor.
 */
export function createAnthropicProvider(
  config: AnthropicDriverConfig,
  resolveMaxOutputTokens: () => number
): DroneLlmProvider {
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com';

  return {
    chat: async ({
      model,
      messages,
      tools,
      reasoningLevel,
      debug,
      parameters,
      extra,
      maxOutputTokens,
      hasVision,
    }) => {
      if (!config.apiKey) {
        throw new DroneLlmError(
          'Anthropic API key is not configured. Set providers.<id>.apiKey in your config or use a ${VAR} environment reference.'
        );
      }

      const effectiveMaxOutputTokens =
        maxOutputTokens ?? resolveMaxOutputTokens();

      const body = toAnthropicRequestParts({
        model,
        messages,
        reasoningLevel,
        tools,
        maxTokens: effectiveMaxOutputTokens,
        parameters,
        extra,
      });

      if (debug) {
        console.error(`[llm:request] POST ${baseUrl}/v1/messages`);
        console.error(`[llm:request] ${JSON.stringify(body)}`);
        console.error(
          `[llm:request] resolved metadata: maxOutputTokens=${String(maxOutputTokens)} hasVision=${String(hasVision)}`
        );
      }

      let response: Response;
      try {
        response = await fetch(baseUrl + '/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': config.apiVersion ?? '2023-06-01',
            ...config.headers,
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DroneLlmError(
          `Anthropic request failed for model ${model}: ${message}`,
          { retryable: false }
        );
      }

      if (!response.ok) {
        let errorBody: string;
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
          `Anthropic API error (${response.status}): ${errorBody}`,
          {
            status: response.status,
            retryAfterMs,
            retryable: isTransientStatus(response.status),
            body: errorBody,
          }
        );
      }

      let data;
      try {
        const responseText = await response.text();
        if (debug) {
          console.error(
            `[llm:response] ${response.status} ${response.statusText}`
          );
          console.error(`[llm:response] ${responseText}`);
        }
        data = JSON.parse(responseText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DroneLlmError(`Anthropic returned invalid JSON: ${message}`, {
          retryable: false,
        });
      }

      return fromAnthropicResponse(data);
    },
    supportsImagesInToolResults: true,
  };
}

export async function discoverAnthropicModels(): Promise<DiscoveredModel[]> {
  // No public list endpoint — supply the known vision-capable families with
  // conservative context windows. User declarations override per-key.
  return [
    { id: 'claude-haiku-4-5', hasVision: true, supportsTools: true },
    { id: 'claude-sonnet-4-6', hasVision: true, supportsTools: true },
    { id: 'claude-opus-4-8', hasVision: true, supportsTools: true },
  ];
}

import { DroneLlmError, type DroneChatResponse } from 'drone-core';
import {
  isTransientStatus,
  parseRetryAfterMs,
} from '../../runtime/llm-retry.js';

export type EchoDriverConfig = {
  baseUrl?: string;
};

type EchoMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

function toEchoMessage(msg: { role: string; content: string }): EchoMessage {
  // Filter out tool messages - they don't have a valid role for the echo API
  if (msg.role === 'tool') {
    return { role: 'user', content: msg.content };
  }
  return {
    role: msg.role as EchoMessage['role'],
    content: msg.content,
  };
}

export const echoParameterSchema = {
  parameters: {
    temperature: { type: 'number' },
    maxTokens: { type: 'number', description: 'Wire key: max_tokens.' },
  },
} as const;

export function createEchoProvider(config: EchoDriverConfig) {
  const baseUrl =
    config.baseUrl ?? process.env.LLM_ECHO_URL ?? 'http://localhost:3458';
  return {
    chat: async (
      request: import('drone-core').DroneChatRequest
    ): Promise<DroneChatResponse> => {
      const body = {
        model: request.model,
        messages: request.messages.map(toEchoMessage),
        ...(request.parameters?.['temperature'] !== undefined
          ? { temperature: request.parameters['temperature'] }
          : {}),
        ...(request.maxOutputTokens !== undefined
          ? { max_tokens: request.maxOutputTokens }
          : {}),
      };

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DroneLlmError(
          `Echo request failed for model ${request.model}: ${message}`,
          { retryable: false }
        );
      }

      if (!response.ok) {
        const errorBody = await response.text();
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get('retry-after') ?? undefined
        );
        throw new DroneLlmError(
          `Echo provider API error (${response.status}): ${errorBody}`,
          {
            status: response.status,
            retryAfterMs,
            retryable: isTransientStatus(response.status),
            body: errorBody,
          }
        );
      }

      const data = (await response.json()) as {
        choices: Array<{ message: EchoMessage }>;
      };
      const choice = data.choices[0];
      if (!choice) {
        throw new DroneLlmError('Echo provider returned no choices', {
          retryable: false,
        });
      }

      return {
        message: choice.message.content,
      };
    },
    getContextWindowInfo: async ({ model }: { model: string }) => ({
      model,
      contextWindowTokens: 32768,
      source: 'default' as const,
    }),
  };
}

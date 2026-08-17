/**
 * Echo LLM Provider Plugin
 *
 * A mock LLM provider that echoes back prompts for deterministic testing.
 * This provider connects to the echo-llm Docker service or any compatible endpoint.
 */

import type {
  DroneChatMessage,
  DroneChatResponse,
  DroneContextWindowInfo,
  DroneLlmCapability,
  DroneLlmProvider,
  DroneLlmProviderRegistration,
  DronePlugin,
} from 'drone-core';
import { PRECEDENCE_LLM_PROVIDER } from 'drone-core';

// ── Echo API types ────────────────────────────────────────────────────

type EchoMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type EchoChatRequest = {
  model: string;
  messages: EchoMessage[];
  temperature?: number;
  max_tokens?: number;
};

type EchoChatChoice = {
  message: EchoMessage;
  finish_reason: string;
};

type EchoChatResponse = {
  id: string;
  choices: EchoChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

// ── Message conversion ─────────────────────────────────────────────

function toEchoMessage(msg: DroneChatMessage): EchoMessage {
  // Filter out tool messages - they don't have a valid role for the echo API
  if (msg.role === 'tool') {
    return { role: 'user', content: msg.content };
  }
  return {
    role: msg.role,
    content: msg.content,
  };
}

function fromEchoResponse(response: EchoChatResponse): DroneChatResponse {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error('Echo provider returned no choices');
  }

  return {
    message: choice.message.content,
  };
}

// ── Provider implementation ─────────────────────────────────────────

export const echoPlugin: DronePlugin = {
  metadata: {
    id: 'echo',
    name: 'Echo LLM Provider',
    version: '1.0.0',
    description:
      'Mock LLM provider that echoes prompts for deterministic testing',
    defaultEnabled: false,
    dependencies: [{ id: 'llm' }],
  },

  async register(registration) {
    // Get echo provider URL from environment (recommended for Docker)
    const echoUrl = process.env.LLM_ECHO_URL || 'http://localhost:3458';
    const model = process.env.LLM_ECHO_MODEL || 'echo-model';

    registration.logger.info(`Echo LLM provider connecting to: ${echoUrl}`);

    const provider: DroneLlmProvider = {
      async chat(params) {
        const { messages, reasoningLevel } = params;

        const body: EchoChatRequest = {
          model,
          messages: messages.map(toEchoMessage),
        };

        const response = await fetch(`${echoUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(
            `Echo provider API error (${response.status}): ${errorBody}`
          );
        }

        const data = (await response.json()) as EchoChatResponse;
        return fromEchoResponse(data);
      },

      async getContextWindowInfo() {
        // Echo provider doesn't report a real context window. Report a
        // generous default (matching the config default) so the safety-trim
        // budget doesn't trip on the system prompt alone.
        return {
          model: model,
          contextWindowTokens: 32768,
          source: 'default' as const,
        } as DroneContextWindowInfo;
      },
    };

    // Register with the LLM broker
    const llmCap = registration.request<DroneLlmCapability>('llm');
    if (llmCap) {
      const llmRegistration: DroneLlmProviderRegistration = {
        id: 'echo',
        precedence: PRECEDENCE_LLM_PROVIDER,
        getProvider: () => provider,
        listModels: async () => [model],
        getDefaultModel: () => model,
      };
      llmCap.registerProvider(llmRegistration);
      registration.logger.info('Echo provider registered with LLM broker');
    } else {
      registration.logger.warn(
        'LLM broker not available; echo will not be registered as a provider'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('Echo provider ready');
    });
  },
};

export default echoPlugin;

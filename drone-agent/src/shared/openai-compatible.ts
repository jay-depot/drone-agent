import type {
  DroneChatMessage,
  DroneChatResponse,
  DroneToolCall,
  DroneToolDescriptor,
} from 'drone-core';
import { toDroneLlmUsage } from 'drone-core';
export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
    };

export type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAiContentPart[];
  reasoning?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: OpenAiToolCall[];
};

export type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenAiTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenAiChatRequest = {
  model: string;
  messages: OpenAiMessage[];
  reasoning?: { effort: string };
  reasoning_effort?: string;
  tools?: OpenAiTool[];
};
export type OpenAiChatChoice = {
  message: OpenAiMessage;
  finish_reason: string;
  reasoning?: string;
};

export type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

export type OpenAiChatResponse = {
  id: string;
  choices: OpenAiChatChoice[];
  usage?: OpenAiUsage;
};

export function toOpenAiMessage(msg: DroneChatMessage): OpenAiMessage {
  const base: OpenAiMessage = {
    role: msg.role,
    content: msg.content,
  };
  // If message has images, build content array
  if (msg.images && msg.images.length > 0) {
    const parts: OpenAiContentPart[] = [];
    if (msg.content) {
      parts.push({ type: 'text', text: msg.content });
    }
    for (const img of msg.images) {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType};base64,${img.data}`,
          detail: 'auto',
        },
      });
    }
    base.content = parts;
  }

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

export function toOpenAiTools(tools: DroneToolDescriptor[]): OpenAiTool[] {
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

export function fromOpenAiResponse(
  openAi: OpenAiChatResponse
): DroneChatResponse {
  const choice = openAi.choices?.[0];
  if (!choice) {
    return { message: '' };
  }

  const result: DroneChatResponse = {
    message:
      typeof choice.message.content === 'string'
        ? choice.message.content
        : Array.isArray(choice.message.content)
          ? choice.message.content
              .filter(
                (p): p is OpenAiContentPart & { type: 'text' } =>
                  p.type === 'text'
              )
              .map(p => p.text)
              .join('\n')
          : '',
  };
  if (choice.reasoning) {
    result.reasoning = choice.reasoning;
  }
  if (!result.reasoning && choice.message.reasoning) {
    result.reasoning = choice.message.reasoning;
  }

  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    // Unparseable or non-object arguments cannot be acted on. They still
    // degrade to {} (DroneToolCall requires an object), but the tool names
    // are collected so the conversation service can treat the response as
    // degenerate instead of executing hollow calls. An empty arguments
    // string is a legitimate zero-argument call, not corruption.
    const malformedToolCalls: string[] = [];
    result.toolCalls = choice.message.tool_calls.map(tc => {
      let parsedArgs: Record<string, unknown> = {};
      const rawArguments = tc.function.arguments;
      if (rawArguments.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(rawArguments);
          if (
            parsed === null ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed)
          ) {
            malformedToolCalls.push(tc.function.name);
          } else {
            parsedArgs = parsed as Record<string, unknown>;
          }
        } catch {
          malformedToolCalls.push(tc.function.name);
        }
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs,
      } satisfies DroneToolCall;
    });
    if (malformedToolCalls.length > 0) {
      result.malformedToolCalls = malformedToolCalls;
    }
  }

  const usage = toDroneLlmUsage({
    prompt: openAi.usage?.prompt_tokens,
    completion: openAi.usage?.completion_tokens,
    total: openAi.usage?.total_tokens,
    cost: openAi.usage?.cost,
    cached: openAi.usage?.prompt_tokens_details?.cached_tokens,
    reasoning: openAi.usage?.completion_tokens_details?.reasoning_tokens,
  });
  if (usage) {
    result.usage = usage;
  }

  return result;
}

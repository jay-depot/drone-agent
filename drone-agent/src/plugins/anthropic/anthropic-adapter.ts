import type { DroneReasoningLevel } from 'drone-core';
import type {
  DroneChatMessage,
  DroneChatResponse,
  DroneToolCall,
  DroneToolDescriptor,
} from 'drone-core';
import { anthropicThinkingBudget } from './anthropic-driver.js';

export type AnthropicTextBlock = {
  type: 'text';
  text: string;
};
export type AnthropicThinkingBlock = {
  type: 'thinking';
  text: string;
  signature?: string;
};

export type AnthropicSignatureBlock = {
  type: 'signature';
  signature: string;
};

export type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
};

export type AnthropicImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicSignatureBlock
  | AnthropicImageBlock;

export type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicChatRequest = {
  model: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  thinking?: { type: 'enabled'; budget_tokens: number };
};

export type AnthropicChatResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    signature?: string;
  }>;
  usage?: { input_tokens: number; output_tokens: number };
};

export function toAnthropicRequestParts(input: {
  messages: DroneChatMessage[];
  tools?: DroneToolDescriptor[];
  maxTokens: number;
  model: string;
  reasoningLevel?: DroneReasoningLevel;
  parameters?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}): AnthropicChatRequest {
  const systemMessages = input.messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .filter(Boolean);

  const nonSystemMessages = input.messages.filter(
    message => message.role !== 'system'
  );

  const request: AnthropicChatRequest = {
    model: input.model,
    max_tokens: input.maxTokens,
    messages: nonSystemMessages.map(toAnthropicMessage),
  };

  if (systemMessages.length > 0) {
    request.system = systemMessages.join('\n\n');
  }

  if (input.tools && input.tools.length > 0) {
    request.tools = toAnthropicTools(input.tools);
  }

  const wireNames: Record<string, string> = {
    topP: 'top_p',
    topK: 'top_k',
    stopSequences: 'stop_sequences',
    temperature: 'temperature',
  };
  for (const [key, value] of Object.entries(input.parameters ?? {})) {
    if (value === undefined || value === null) continue;
    (request as Record<string, unknown>)[wireNames[key] ?? key] = value;
  }
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    (request as Record<string, unknown>)[key] = value;
  }

  if (input.reasoningLevel && input.reasoningLevel !== 'off') {
    const budget = anthropicThinkingBudget(
      input.reasoningLevel,
      input.maxTokens
    );
    if (budget !== undefined) {
      request.thinking = {
        type: 'enabled',
        budget_tokens: budget,
      };
    }
  }

  return request;
}

function toAnthropicMessage(message: DroneChatMessage): AnthropicMessage {
  if (message.role === 'tool') {
    const content: AnthropicContentBlock[] = [];
    if (message.images && message.images.length > 0) {
      for (const img of message.images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data },
        });
      }
    }
    content.push({
      type: 'tool_result',
      tool_use_id:
        message.toolCallId ?? `call_${Math.random().toString(36).slice(2, 10)}`,
      content: message.content,
    });
    return {
      role: 'user',
      content,
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    const content: AnthropicContentBlock[] = [];
    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }
    if (message.images) {
      for (const img of message.images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data },
        });
      }
    }
    for (const toolCall of message.toolCalls) {
      content.push({
        type: 'tool_use',
        id: toolCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        name: toolCall.name,
        input: toolCall.arguments,
      });
    }
    return {
      role: 'assistant',
      content,
    };
  }

  if (message.images && message.images.length > 0) {
    const content: AnthropicContentBlock[] = [];
    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }
    for (const img of message.images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.data },
      });
    }
    return {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content,
    };
  }

  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: message.content }],
  };
}

function toAnthropicTools(tools: DroneToolDescriptor[]): AnthropicTool[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: (tool.inputSchema ?? {
      type: 'object',
      properties: {},
      additionalProperties: true,
    }) as Record<string, unknown>,
  }));
}

export function fromAnthropicResponse(
  response: AnthropicChatResponse
): DroneChatResponse {
  const textParts: string[] = [];
  const toolCalls: DroneToolCall[] = [];

  let reasoning: string | undefined;
  for (const block of response.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }
    if (block.type === 'tool_use' && block.name) {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input ?? {},
      });
      continue;
    }

    if (block.type === 'thinking' && typeof block.text === 'string') {
      reasoning = reasoning ? reasoning + '\n' + block.text : block.text;
      continue;
    }

    if (block.type === 'signature') {
      continue;
    }
  }
  const result: DroneChatResponse = {
    message: textParts.join('\n').trim(),
  };
  if (reasoning) {
    result.reasoning = reasoning;
  }

  if (toolCalls.length > 0) {
    result.toolCalls = toolCalls;
  }

  return result;
}

/**
 * @internal Exposed for unit tests. Not part of the public API.
 */
export const __testing = { toAnthropicMessage };

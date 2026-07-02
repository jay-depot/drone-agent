import type {
  DroneChatMessage,
  DroneChatResponse,
  DroneToolCall,
  DroneToolDescriptor,
} from 'drone-core';

export type AnthropicTextBlock = {
  type: 'text';
  text: string;
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

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

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
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
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
  }>;
};

export function toAnthropicRequestParts(input: {
  messages: DroneChatMessage[];
  tools?: DroneToolDescriptor[];
  maxTokens: number;
  model: string;
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

  return request;
}

function toAnthropicMessage(message: DroneChatMessage): AnthropicMessage {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id:
            message.toolCallId ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          content: message.content,
        },
      ],
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    const content: AnthropicContentBlock[] = [];
    if (message.content) {
      content.push({ type: 'text', text: message.content });
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
    }
  }

  const result: DroneChatResponse = {
    message: textParts.join('\n').trim(),
  };

  if (toolCalls.length > 0) {
    result.toolCalls = toolCalls;
  }

  return result;
}
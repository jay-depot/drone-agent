import type {
  DroneChatMessage,
  DroneSessionConfig,
  DroneSessionTurn,
  DroneTokenEstimate,
  DroneToolDescriptor,
} from './index.js';

export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 1;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessageTokens(message: DroneChatMessage): number {
  let total = 6 + estimateTextTokens(message.content);

  if (message.toolName) {
    total += estimateTextTokens(message.toolName);
  }

  if (message.toolCallId) {
    total += estimateTextTokens(message.toolCallId);
  }

  if (message.toolCalls && message.toolCalls.length > 0) {
    total += estimateTextTokens(JSON.stringify(message.toolCalls));
  }
  if (message.images) {
    for (const img of message.images) {
      total += 256; // rough estimate per image for vision models
    }
  }


  return total;
}

export function estimateToolDescriptorTokens(
  tool: DroneToolDescriptor
): number {
  return (
    8 +
    estimateTextTokens(tool.name) +
    estimateTextTokens(tool.description) +
    estimateTextTokens(JSON.stringify(tool.inputSchema ?? {}))
  );
}

export function estimateSessionBudget(input: {
  systemMessages: DroneChatMessage[];
  turns: DroneSessionTurn[];
  tools: DroneToolDescriptor[];
  sessionConfig: DroneSessionConfig;
  contextWindowTokens: number;
}): DroneTokenEstimate {
  const estimatedSystemTokens = input.systemMessages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0
  );
  const estimatedSessionTokens = input.turns.reduce(
    (sum, turn) =>
      sum +
      turn.messages.reduce(
        (messageSum, message) => messageSum + estimateMessageTokens(message),
        0
      ),
    0
  );
  const estimatedToolTokens = input.tools.reduce(
    (sum, tool) => sum + estimateToolDescriptorTokens(tool),
    0
  );
  const estimatedPromptTokens =
    estimatedSystemTokens + estimatedSessionTokens + estimatedToolTokens;
  const reservedResponseTokens = input.sessionConfig.responseReserveTokens;
  const estimatedTotalTokens = estimatedPromptTokens + reservedResponseTokens;
  const maxPromptTokens = Math.max(
    1,
    input.contextWindowTokens - reservedResponseTokens
  );

  return {
    estimatedSystemTokens,
    estimatedSessionTokens,
    estimatedToolTokens,
    estimatedPromptTokens,
    reservedResponseTokens,
    estimatedTotalTokens,
    contextWindowTokens: input.contextWindowTokens,
    maxPromptTokens,
    requiresSafetyTrim: estimatedPromptTokens > maxPromptTokens,
  };
}

export function estimateTurnTokens(turn: DroneSessionTurn): number {
  return turn.messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0
  );
}

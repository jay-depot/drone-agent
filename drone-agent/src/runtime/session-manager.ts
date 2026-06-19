import type {
  DroneSessionMessage,
  DroneSessionState,
  DroneSessionTurn,
  DroneToolCall,
} from 'drone-core';
import { randomUUID } from 'node:crypto';

export type DroneSessionManager = {
  appendUserMessage: (content: string) => void;
  appendAssistantMessage: (
    content: string,
    toolCalls?: DroneToolCall[]
  ) => void;
  appendToolResult: (
    toolName: string,
    content: string,
    toolCallId?: string
  ) => void;
  getMessages: () => DroneSessionMessage[];
  getTurns: () => DroneSessionTurn[];
  dropOldestTurns: (count: number) => DroneSessionTurn[];
  clearSession: () => void;
  getState: () => DroneSessionState;
};

export function createSessionManager(): DroneSessionManager {
  const turns: DroneSessionTurn[] = [];

  function createTurn(message: DroneSessionMessage): DroneSessionTurn {
    return {
      id: randomUUID(),
      messages: [message],
    };
  }

  function appendToCurrentTurn(message: DroneSessionMessage): void {
    const currentTurn = turns.at(-1);
    if (!currentTurn) {
      turns.push(createTurn(message));
      return;
    }

    currentTurn.messages.push(message);
  }

  function flattenMessages(): DroneSessionMessage[] {
    return turns.flatMap(turn => turn.messages);
  }

  return {
    appendUserMessage: content => {
      turns.push(
        createTurn({
          role: 'user',
          content,
        })
      );
    },
    appendAssistantMessage: (content, toolCalls) => {
      appendToCurrentTurn({
        role: 'assistant',
        content,
        toolCalls,
      });
    },
    appendToolResult: (toolName, content, toolCallId) => {
      appendToCurrentTurn({
        role: 'tool',
        content,
        toolName,
        toolCallId,
      });
    },
    getMessages: () => flattenMessages(),
    getTurns: () =>
      turns.map(turn => ({ id: turn.id, messages: [...turn.messages] })),
    dropOldestTurns: count => {
      if (count <= 0) {
        return [];
      }

      return turns.splice(0, count);
    },
    clearSession: () => {
      turns.length = 0;
    },
    getState: () => ({
      messages: flattenMessages(),
      turns: turns.map(turn => ({ id: turn.id, messages: [...turn.messages] })),
    }),
  };
}

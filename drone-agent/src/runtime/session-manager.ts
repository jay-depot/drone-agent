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
  dropOldestNonSummaryTurns: (count: number) => DroneSessionTurn[];
  getSummaryTurns: () => DroneSessionTurn[];
  dropSummaryTurnById: (id: string) => DroneSessionTurn | null;
  prependSystemTurn: (
    content: string,
    opts?: { kind?: 'summary' }
  ) => DroneSessionTurn;
  clearSession: () => void;
  getState: () => DroneSessionState;
};

export function createSessionManager(): DroneSessionManager {
  const turns: DroneSessionTurn[] = [];

  function createTurn(
    message: DroneSessionMessage,
    kind?: 'summary'
  ): DroneSessionTurn {
    return {
      id: randomUUID(),
      messages: [message],
      kind,
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

  function isSummaryTurn(turn: DroneSessionTurn): boolean {
    return turn.kind === 'summary';
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
    dropOldestNonSummaryTurns: count => {
      if (count <= 0) {
        return [];
      }

      const dropped: DroneSessionTurn[] = [];
      while (dropped.length < count && turns.length > 0) {
        const head = turns[0];
        if (isSummaryTurn(head)) {
          break;
        }
        dropped.push(turns.shift() as DroneSessionTurn);
      }
      return dropped;
    },
    getSummaryTurns: () =>
      turns
        .filter(isSummaryTurn)
        .map(turn => ({ id: turn.id, messages: [...turn.messages] })),
    dropSummaryTurnById: id => {
      const index = turns.findIndex(
        turn => turn.id === id && isSummaryTurn(turn)
      );
      if (index === -1) {
        return null;
      }

      const [dropped] = turns.splice(index, 1);
      return dropped;
    },
    prependSystemTurn: (content, opts) => {
      const kind = opts?.kind;
      const turn = createTurn({ role: 'system', content }, kind);
      turns.unshift(turn);
      return turn;
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

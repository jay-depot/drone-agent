import type {
  DroneImageContent,
  DroneSessionMessage,
  DroneSessionTurn,
  DroneToolCall,
} from 'drone-core';
import { randomUUID } from 'node:crypto';
import { getOldestNonSummaryTurns } from './turn-utils.js';
export type DroneSessionManager = {
  appendUserMessage: (content: string, images?: DroneImageContent[]) => void;
  appendAssistantMessage: (
    content: string,
    toolCalls?: DroneToolCall[]
  ) => void;
  appendToolResult: (
    toolName: string,
    content: string,
    toolCallId?: string,
    images?: DroneImageContent[]
  ) => void;
  updateLastToolResultImages: (images: DroneImageContent[]) => void;
  getMessages: () => DroneSessionMessage[];
  getTurns: () => DroneSessionTurn[];
  dropOldestNonSummaryTurns: (count: number) => DroneSessionTurn[];
  getSummaryTurns: () => DroneSessionTurn[];
  dropSummaryTurnById: (id: string) => DroneSessionTurn | null;
  dropTurnsByIds: (ids: string[]) => DroneSessionTurn[];
  prependSystemTurn: (
    content: string,
    opts?: { kind?: 'summary' }
  ) => DroneSessionTurn;
  clearSession: () => void;
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

  function dropTurnsByIdsInternal(ids: string[]): DroneSessionTurn[] {
    if (ids.length === 0) {
      return [];
    }

    const idSet = new Set(ids);
    const removed: DroneSessionTurn[] = [];
    for (let i = turns.length - 1; i >= 0; i--) {
      if (idSet.has(turns[i].id)) {
        removed.unshift(turns.splice(i, 1)[0]);
      }
    }
    return removed;
  }

  return {
    appendUserMessage: (content, images) => {
      turns.push(
        createTurn({
          role: 'user',
          content,
          images,
        })
      );
    },
    appendAssistantMessage: (content, toolCalls) => {
      turns.push(
        createTurn({
          role: 'assistant',
          content,
          toolCalls,
        })
      );
    },
    appendToolResult: (toolName, content, toolCallId, images) => {
      appendToCurrentTurn({
        role: 'tool',
        content,
        toolName,
        toolCallId,
        images,
      });
    },
    updateLastToolResultImages: images => {
      const lastTurn = turns.at(-1);
      if (lastTurn) {
        const lastToolMsg = [...lastTurn.messages]
          .reverse()
          .find(m => m.role === 'tool');
        if (lastToolMsg) {
          lastToolMsg.images = images;
        }
      }
    },
    getMessages: () => flattenMessages(),
    getTurns: () =>
      turns.map(turn => ({
        id: turn.id,
        messages: [...turn.messages],
        kind: turn.kind,
      })),
    dropOldestNonSummaryTurns: count => {
      if (count <= 0) {
        return [];
      }

      const toDrop = getOldestNonSummaryTurns(turns, count);
      return dropTurnsByIdsInternal(toDrop.map(turn => turn.id));
    },
    getSummaryTurns: () =>
      turns.filter(isSummaryTurn).map(turn => ({
        id: turn.id,
        messages: [...turn.messages],
        kind: turn.kind,
      })),
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
    dropTurnsByIds: dropTurnsByIdsInternal,
    prependSystemTurn: (content, opts) => {
      const kind = opts?.kind;
      const turn = createTurn({ role: 'system', content }, kind);
      turns.unshift(turn);
      return turn;
    },
    clearSession: () => {
      turns.length = 0;
    },
  };
}

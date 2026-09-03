import type { DroneConversationEvent } from 'drone-core';

/**
 * The tight round window for swarm-memory retrieval:
 * [previous round's user query + previous round's steering messages +
 * previous round's final assistant response + current round's query].
 */
export interface WindowParts {
  currentQuery: string;
  prevUserQuery: string;
  prevSteering: string[];
  prevResponse: string;
}

interface TrackedRound {
  userQuery: string;
  steering: string[];
  lastResponse: string;
}

function isMeaningful(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * Tracks conversation events to assemble the retrieval window. A "round" is
 * one sendUserMessage call; the engine emits a `roundComplete` event when it
 * finishes (including on error/cancel), which closes the round. Assistant
 * messages overwrite the round's last response, so the final response wins.
 * User messages arriving inside an in-flight round are steering messages.
 * Tool/reasoning/progress events are ignored — they are the noise the filter
 * would strip anyway.
 */
export class ConversationWindowTracker {
  private completed: TrackedRound[] = [];
  private current: TrackedRound | null = null;
  private sawAssistantInCurrent = false;

  onEvent(event: DroneConversationEvent): void {
    if (event.kind === 'roundComplete') {
      if (this.current) {
        this.completed.push(this.current);
        this.current = null;
      }
      this.sawAssistantInCurrent = false;
      return;
    }
    if (event.kind === 'userMessage') {
      if (!this.current) {
        this.current = {
          userQuery: event.content,
          steering: [],
          lastResponse: '',
        };
        return;
      }
      if (!isMeaningful(this.current.userQuery)) {
        this.current.userQuery = event.content;
      } else {
        this.current.steering.push(event.content);
      }
      return;
    }
    if (event.kind === 'assistantMessage') {
      if (!this.current) {
        this.current = { userQuery: '', steering: [], lastResponse: '' };
      }
      this.current.lastResponse = event.content;
      this.sawAssistantInCurrent = true;
    }
  }

  /** The tight retrieval window from tracked conversation state. */
  assemble(): WindowParts {
    const prev = this.completed[this.completed.length - 1] ?? null;
    const currentQuery = this.current?.userQuery.trim() || '';
    return {
      currentQuery,
      prevUserQuery: prev?.userQuery ?? '',
      prevSteering: prev?.steering ?? [],
      prevResponse: prev?.lastResponse ?? '',
    };
  }

  reset(): void {
    this.completed = [];
    this.current = null;
    this.sawAssistantInCurrent = false;
  }
}

/**
 * Strip code/tool noise from window text before it is used for embedding or
 * debounce hashing. Deterministic: identical input always yields identical
 * output. Deliberately conservative — real prose (the retrieval signal) is
 * kept; machine-shaped runs (code fences, tool payloads, paths, hashes, long
 * symbol-dense runs) are removed.
 */
export function filterForQuery(text: string): string {
  let result = text;

  // Fenced code blocks.
  result = result.replace(/```[\s\S]*?```/g, ' ');

  // Brace-only lines (pretty-printed tool payload skeletons).
  result = result
    .split('\n')
    .filter(line => !/^\s*[{}[\]]\s*$/.test(line.trim()))
    .join('\n');

  // Absolute paths (3+ segments) and file:line refs.
  result = result.replace(/(?:\/[\w.@+-]+){3,}/g, ' ');
  result = result.replace(/\b[\w./-]+\.\w{1,4}:\d+\b/g, ' ');

  // Long hex hashes / ids.
  result = result.replace(/\b[0-9a-f]{16,}\b/gi, ' ');

  // Symbol-dense runs (likely code identifiers or signatures).
  result = result.replace(/[\w$@./:+-]{48,}/g, ' ');

  // Collapse whitespace.
  return result.replace(/\s+/g, ' ').trim();
}

import type { DroneSessionMessage } from 'drone-core';

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

/** Minimal session-manager surface the window assembler needs. */
export interface SessionMessagesSource {
  getMessages(): DroneSessionMessage[];
}

/**
 * Split the flat message list into rounds. A round begins at a user message
 * that follows a *completed* assistant turn (a final response with no pending
 * tool calls) or at the start of the session. A user message arriving after
 * tool results — or after an assistant message that still carries tool calls —
 * is mid-round steering, not a new round.
 */
function groupIntoRounds(
  messages: DroneSessionMessage[]
): DroneSessionMessage[][] {
  const rounds: DroneSessionMessage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const prev = i > 0 ? messages[i - 1] : undefined;
    const prevIsFinalAssistant =
      prev?.role === 'assistant' &&
      (!prev.toolCalls || prev.toolCalls.length === 0);
    const startsNewRound = rounds.length === 0 || (message.role === 'user' && prevIsFinalAssistant);
    if (startsNewRound) {
      rounds.push([message]);
    } else {
      rounds[rounds.length - 1].push(message);
    }
  }
  return rounds;
}

function contentOf(message: DroneSessionMessage): string {
  return typeof message.content === 'string' ? message.content : '';
}

function isMeaningfulUserText(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * Extract the window parts from the raw message list and the current round's
 * query. The current query is the just-submitted user text (not necessarily in
 * the session yet, so it is passed explicitly and takes precedence). The
 * previous round is the most recent round that ends with an assistant message.
 */
export function assembleWindow(
  getMessages: SessionMessagesSource['getMessages'],
  currentQuery: string
): WindowParts {
  const query = currentQuery.trim();
  const parts: WindowParts = {
    currentQuery: query,
    prevUserQuery: '',
    prevSteering: [],
    prevResponse: '',
  };

  const rounds = groupIntoRounds(getMessages());

  // Walk backwards past the trailing (in-progress) round; the previous round
  // is the most recent one that produced an assistant response.
  let end = rounds.length;
  if (end > 0) {
    const last = rounds[end - 1];
    const lastRoundHasAssistant = last.some(
      m => m.role === 'assistant' && isMeaningfulUserText(contentOf(m))
    );
    if (!lastRoundHasAssistant) end = end - 1;
  }

  for (let i = end - 1; i >= 0; i--) {
    const round = rounds[i];
    const userMessages = round.filter(
      m => m.role === 'user' && isMeaningfulUserText(contentOf(m))
    );
    const assistantMessages = round.filter(
      m => m.role === 'assistant' && isMeaningfulUserText(contentOf(m))
    );
    if (userMessages.length === 0 || assistantMessages.length === 0) {
      continue;
    }
    parts.prevUserQuery = contentOf(userMessages[0]);
    parts.prevSteering = userMessages
      .slice(1)
      .map(contentOf)
      .filter(isMeaningfulUserText);
    parts.prevResponse = contentOf(assistantMessages[assistantMessages.length - 1]);
    break;
  }

  return parts;
}

/**
 * Strip code/tool noise from window text before it is used for embedding or
 * debounce hashing. Deterministic: identical input always yields identical
 * output. Deliberately conservative — real prose (the retrieval signal) is
 * kept; machine-shaped runs (code fences, tool JSON, paths, hashes, long
 * symbol-dense runs) are removed.
 */
export function filterForQuery(text: string): string {
  let result = text;

  // Fenced code blocks.
  result = result.replace(/```[\s\S]*?```/g, ' ');

  // Indented JSON-ish tool blocks (lines starting with { or }).
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
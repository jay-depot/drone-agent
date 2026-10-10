import type { DroneChatMessage } from 'drone-core';

/**
 * Presentation-only repair of orphan tool messages. A tool message whose
 * toolCallId is empty, or matches no PRECEDING assistant tool-call id, is
 * coerced to a `user` message (content preserved). This keeps the wire
 * representation valid for strict OpenAI-family providers without touching the
 * stored session. Returns a new array; inputs are not mutated.
 */
export function coerceOrphanToolMessages(
  messages: DroneChatMessage[]
): DroneChatMessage[] {
  const declaredIds = new Set<string>();
  const out: DroneChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.id) declaredIds.add(tc.id);
      }
    }
    if (
      msg.role === 'tool' &&
      (!msg.toolCallId || !declaredIds.has(msg.toolCallId))
    ) {
      out.push({ ...msg, role: 'user' });
      continue;
    }
    out.push(msg);
  }
  return out;
}

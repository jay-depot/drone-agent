import type { AdapterMessage } from './types.js';

/** The exact reply an agent sends to decline to respond. */
export const NO_RESPONSE_SENTINEL = '<<NO_RESPONSE>>';

/** The per-turn instruction injected into multi-user room conversations. */
export const ROOM_INSTRUCTION =
  'You are participating in a group chat with multiple people. Each incoming message is\n' +
  'tagged with the sender\'s name in square brackets, for example "[Alice] hello". People\n' +
  'often address each other rather than you. Before answering, decide whether a reply is\n' +
  'actually warranted — answer only if you have something useful to contribute, or if you\n' +
  'are directly addressed. If no response is warranted, reply with exactly <<NO_RESPONSE>>\n' +
  'and nothing else; your reply will not be sent.';

/** True when a reply is the decline-to-respond sentinel. Exact match modulo trim. */
export function isNoResponse(reply: string): boolean {
  return reply.trim() === NO_RESPONSE_SENTINEL;
}

/**
 * Tag a single inbound turn with the speaker's name: `[Alice] fix the build`.
 * Falls back senderName → senderId → 'unknown'. Only the first line is prefixed.
 */
export function formatChatTurn(
  msg: Pick<AdapterMessage, 'senderName' | 'senderId' | 'text'>
): string {
  const name = msg.senderName?.trim() || msg.senderId?.trim() || 'unknown';
  return `[${name}] ${msg.text}`;
}

import type { AdapterMessage } from './types.js';
import type { SurfaceMode } from './surfaces/mode.js';

/** The exact reply an agent sends to decline to respond. */
export const NO_RESPONSE_SENTINEL = '<<NO_RESPONSE>>';

/** The per-turn instruction injected into multi-user room conversations. */
export const ROOM_INSTRUCTION =
  'You are participating in a group chat with multiple people. Each incoming message is\n' +
  'headed by its sender in square brackets, for example "[<id> from: Alice]". People\n' +
  'often address each other rather than you. Before answering, decide whether a reply is\n' +
  'actually warranted — answer only if you have something useful to contribute, or if you\n' +
  'are directly addressed. If no response is warranted, reply with exactly <<NO_RESPONSE>>\n' +
  'and nothing else; your reply will not be sent.';

/**
 * The per-turn instruction for a silent observation round (observer, and a
 * passive conversation's ordinary catch-up).
 */
export const OBSERVER_INSTRUCTION =
  'You are observing this conversation as a silent notetaker. Other people are talking to\n' +
  'each other. Do NOT reply in chat. Use your tools to record anything worth remembering\n' +
  '(notes, memories, wiki pages, todos); anything you would say is for your own records only.';

/** The per-turn instruction for a passive conversation's mention round. */
export const MENTION_INSTRUCTION =
  'You have been mentioned in this conversation. In addition to your usual observation,\n' +
  'you MUST reply to the last message, addressing the person who mentioned you.';

/** `'__CANCELLED__'` — the soft-cancel sentinel produced by a cancelled agent turn. */
export const CANCEL_SENTINEL = '__CANCELLED__';

/** True when a reply is the soft-cancel sentinel (never post it). */
export function isCancelled(reply: string): boolean {
  return reply.trim() === CANCEL_SENTINEL;
}

/**
 * The non-persisted system reminder for a turn, selected by mode. `undefined`
 * means "no reminder" (a plain active DM turn). In a room an active turn keeps
 * ROOM_INSTRUCTION; an observer/passive round uses the observation instruction
 * instead (so the model is told not to reply rather than told it may decline).
 */
export function composeSystemReminder(
  mode: SurfaceMode,
  kind: 'dm' | 'room',
  mentioned: boolean
): string | undefined {
  if (mode === 'active') return kind === 'room' ? ROOM_INSTRUCTION : undefined;
  if (mode === 'observer') return OBSERVER_INSTRUCTION;
  return mentioned ? MENTION_INSTRUCTION : OBSERVER_INSTRUCTION;
}

/** True when a reply is the decline-to-respond sentinel. Exact match modulo trim. */
export function isNoResponse(reply: string): boolean {
  return reply.trim() === NO_RESPONSE_SENTINEL;
}

/**
 * Tag a single inbound turn with the speaker's name and the message id, as a
 * header line: `[<message-id> from: <Name>]` then the body on the following
 * line(s). Falls back senderName → senderId → 'unknown'; falls back to `-` for
 * a message with no platform ref. The id is inert until the reactions feature
 * teaches the model the format.
 */
export function formatChatTurn(
  msg: Pick<AdapterMessage, 'senderName' | 'senderId' | 'platformRef' | 'text'>
): string {
  const name = msg.senderName?.trim() || msg.senderId?.trim() || 'unknown';
  const ref = msg.platformRef?.trim() || '-';
  return `[${ref} from: ${name}]\n${msg.text}`;
}

/** Preamble before the drained outbound ledger entries in a user turn. */
export const OUTBOUND_LEDGER_PREAMBLE =
  'Messages you posted to this conversation while you were not running:';

/** Format one drained outbound ledger entry as its own header line + body. */
export function formatOutboundPost(entry: {
  platformRef?: string;
  text: string;
}): string {
  const ref = entry.platformRef?.trim() || '-';
  return `[${ref} posted by you]\n${entry.text}`;
}

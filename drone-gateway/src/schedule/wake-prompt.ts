import { isCancelled, isNoResponse } from '../chat-format.js';

/** The per-turn instruction carried by a wake-up round. */
export const WAKE_INSTRUCTION =
  'This is a scheduled wake-up you set earlier. Reply to the user now. ' +
  'If you truly have nothing to say, reply with exactly <<NO_RESPONSE>>.';

/** Build the synthetic user turn a wake-up delivers to the agent. */
export function buildWakePrompt(note: string, dueAt: number): string {
  return (
    '[scheduled wake-up] You set this reminder for the user earlier:\n\n' +
    `  ${note}\n\n` +
    `It became due at ${new Date(dueAt).toISOString()}. Act on it now.`
  );
}

/** What a wake-up reply does downstream. */
export type WakeOutcome = 'posted' | 'sentinel' | 'empty';

/**
 * Classify a wake-up reply. Delivery only — every outcome still counts as a
 * triggered wake-up (the row is deleted on a resolved send regardless).
 */
export function classifyWakeReply(reply: string | null): WakeOutcome {
  if (reply === null) return 'empty';
  if (isCancelled(reply) || isNoResponse(reply)) return 'sentinel';
  if (reply.trim() === '') return 'empty';
  return 'posted';
}

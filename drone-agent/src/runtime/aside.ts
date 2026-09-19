import type { DroneChatMessage } from 'drone-core';

/**
 * Framing line prepended to a `/btw` side question. The copied context is sent
 * verbatim (including any prose that references tools), but the side-query runs
 * with no tools available — this line tells the model to answer in prose rather
 * than attempting a tool call it cannot make.
 */
export const ASIDE_FRAMING =
  'SIDE QUESTION (aside): the user is asking a question about the conversation ' +
  'above. Answer it directly and concisely in prose. No tools are available in ' +
  'this context, so do not attempt to call one.';

/**
 * Assemble the message array for a `/btw` side-query: the current context
 * (header system messages, session turns, footer system messages) with the
 * framed question appended as a final user turn. Pure — the caller owns sending
 * the result to the LLM and discarding it.
 */
export function buildAsideMessages(opts: {
  header: DroneChatMessage[];
  sessionMessages: DroneChatMessage[];
  footer: DroneChatMessage[];
  question: string;
}): DroneChatMessage[] {
  return [
    ...opts.header,
    ...opts.sessionMessages,
    ...opts.footer,
    { role: 'user', content: `${ASIDE_FRAMING}\n\n${opts.question}` },
  ];
}

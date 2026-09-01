/**
 * Kick-message handoff contract (ADR 183): a workflow's `kickMessage` is an
 * INSTRUCTION TO THE AGENT, not a report to the user — reports belong in
 * `toolResult`. The envelope frames the raw message so the model always
 * knows what the synthetic turn is and what it should do with it.
 */
export function buildKickEnvelope(
  workflowName: string,
  kickMessage: string
): string {
  return [
    `Workflow ${workflowName} completed and handed off the following. Read it and continue the session appropriately:`,
    '',
    '---',
    kickMessage,
    '---',
  ].join('\n');
}
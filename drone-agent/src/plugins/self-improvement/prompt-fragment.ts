import type { DronePersonaCapability } from 'drone-core';

/**
 * Render the insight-targets prompt fragment (header).
 */
export async function renderInsightTargetsFragment(
  personaCap?: DronePersonaCapability
): Promise<string> {
  const lines: string[] = ['# Self-Improvement', ''];
  const activePersona = personaCap?.getActivePersona();
  if (activePersona) {
    lines.push(
      'Current active persona: `' +
        activePersona.id +
        '`. ' +
        'Use `self-improvement__insight` with `targetType: "persona"` to record insights about it.'
    );
  }
  lines.push(
    'Use `persona__list` to see all available personas and `skills__list` to see available skills.'
  );
  lines.push(
    'Insight tools: `self-improvement__insight` (record/list/recall).'
  );
  lines.push(
    'Principle tools: `self-improvement__principle` (store/list/recall/delete).'
  );
  return lines.join('\n');
}

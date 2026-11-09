import type { Automation, Card, Column, Project } from './board-types.js';

/**
 * Whether an automation's `when` pair matches a transition.
 *
 * `from` may be `null` (card creation), which matches only `when.from === '*'`.
 * `*` on one side is a wildcard; `*` on both sides is rejected at creation, so
 * at least one side is always concrete.
 */
export function matchesTransition(
  automation: Automation,
  from: string | null,
  to: string
): boolean {
  const fromMatches =
    automation.when.from === '*' ||
    (from !== null && automation.when.from === from);
  const toMatches = automation.when.to === '*' || automation.when.to === to;
  return fromMatches && toMatches;
}

const TOKEN_PATTERN = /\{\{([a-zA-Z.]+)\}\}/g;

/**
 * Render a prompt template. Known tokens are `{{card.title}}`,
 * `{{card.description}}`, `{{column.name}}` (destination column), and
 * `{{project.name}}`; an unknown token renders as an empty string.
 */
export function renderPrompt(
  template: string,
  ctx: { card: Card; column: Column; project: Project }
): string {
  const values: Record<string, string> = {
    'card.title': ctx.card.title,
    'card.description': ctx.card.description ?? '',
    'column.name': ctx.column.name,
    'project.name': ctx.project.name,
  };
  return template.replace(TOKEN_PATTERN, (_match, token: string) =>
    Object.prototype.hasOwnProperty.call(values, token) ? values[token] : ''
  );
}

/** The enabled automations of a project that match a transition. */
export function selectAutomations(
  project: Project,
  from: string | null,
  to: string
): Automation[] {
  return project.automations.filter(
    automation => automation.enabled && matchesTransition(automation, from, to)
  );
}

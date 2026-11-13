import { randomUUID } from 'node:crypto';

/** A new project id (`p_<uuid>`). */
export function newProjectId(): string {
  return `p_${randomUUID()}`;
}

/** A new column id (`col_<uuid>`). */
export function newColumnId(): string {
  return `col_${randomUUID()}`;
}

/** A new card id (`c_<uuid>`), unique for all time. */
export function newCardId(): string {
  return `c_${randomUUID()}`;
}

/** A new automation id (`a_<uuid>`). */
export function newAutomationId(): string {
  return `a_${randomUUID()}`;
}

/** A new job id (`j_<uuid>`). */
export function newJobId(): string {
  return `j_${randomUUID()}`;
}

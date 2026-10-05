/**
 * Renders a raw coordinator payload as a fenced JSON block.
 */
export function formatJson(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

/**
 * A short footer shown when a list response was truncated. The
 * `--limit/--offset` token names the flags that page the endpoint.
 */
export function truncationTail(shown: number, total: number): string {
  if (shown >= total) return '';
  return `… ${total - shown} more (use --limit/--offset)`;
}

/**
 * Joins list lines and appends the truncation tail when the page is short.
 */
export function formatList(lines: string[], total: number): string {
  const body = lines.length > 0 ? lines.join('\n') : '(none)';
  const tail = truncationTail(lines.length, total);
  return tail ? `${body}\n${tail}` : body;
}

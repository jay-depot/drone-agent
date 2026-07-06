/**
 * Shared utility for formatting git diff output.
 *
 * Used by the GitDiffBlock component (tail region) and the toEntry()
 * functions (static scrollback) to produce ANSI-colored diff text
 * and Ink-colored components.
 */

/** Maximum chars rendered in a tool argument or result preview. */
export const PREVIEW_MAX = 200;

/** ANSI color codes for diff output in the static scrollback. */
export const ANSI = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  reset: '\x1b[0m',
};

export function tryParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format a diff result for display with colored +/- indicators and line numbers.
 * Used for the static scrollback entry (toEntry).
 */
export function formatDiffResult(content: string): string {
  const parsed = tryParseJson(content);
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (
      obj.path !== undefined &&
      (obj.written === true || obj.patched === true)
    ) {
      return `✓ Applied diff to ${obj.path}`;
    }
    if (obj.diff && typeof obj.diff === 'string') {
      return formatDiffOutput(obj.diff);
    }
  }

  if (content.includes('---') || content.includes('@@')) {
    return formatDiffOutput(content);
  }

  return content;
}

/**
 * Format diff output with ANSI-colored +/- prefixes and line numbers.
 * Used for the static scrollback entry (toEntry).
 */
export function formatDiffOutput(diff: string): string {
  const lines = diff.split('\n');
  const output: string[] = [];
  let lineNum = 0;

  for (const line of lines) {
    lineNum++;
    if (line.startsWith('+')) {
      output.push(
        `${ANSI.green}+${ANSI.reset}${String(lineNum).padStart(4)} │ ${ANSI.green}${line}${ANSI.reset}`
      );
    } else if (line.startsWith('-')) {
      output.push(
        `${ANSI.red}-${ANSI.reset}${String(lineNum).padStart(4)} │ ${ANSI.red}${line}${ANSI.reset}`
      );
    } else if (line.startsWith('@@')) {
      output.push(` ${String(lineNum).padStart(4)} │ ${line}`);
    } else if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      output.push(` ${String(lineNum).padStart(4)} │ ${line}`);
    } else {
      output.push(` ${String(lineNum).padStart(4)} │ ${line}`);
    }
  }

  return output.join('\n');
}

import type { DroneMacroDefinition, DroneMacroStep } from './types.js';

/**
 * Regex to match positional argument placeholders in a macro line.
 * Matches $1, $2, $1?, $2?, etc.
 */
const POSITIONAL_PATTERN = /\$(\d+)(\?)?/g;

/**
 * Regex to match catch-all argument placeholders.
 * Matches $$ and $$?.
 */
const CATCHALL_PATTERN = /\$\$(\?)?/g;

/**
 * Parse a .macro file string into a DroneMacroDefinition.
 *
 * DSL rules:
 *   - First non-empty line must be `#! /<command> [description]`
 *   - Lines starting with `#` are comments (ignored)
 *   - Lines starting with `/` are slash command steps
 *   - Any other non-empty line is a chat prompt step
 *   - Empty lines are ignored
 *
 * Argument placeholders ($1, $2, $$, $1?, $2?, $$?) are detected
 * across all step lines and recorded in argSpec/hasCatchAll.
 */
export function parseMacroFile(
  content: string,
  filePath: string
): DroneMacroDefinition {
  const lines = content.split('\n');

  // Find the first non-empty line for the declaration.
  let declLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      declLineIndex = i;
      break;
    }
  }

  if (declLineIndex === -1) {
    throw new Error(
      `Invalid macro file "${filePath}": file is empty or contains only whitespace.`
    );
  }

  const declLine = lines[declLineIndex].trim();
  const declMatch = declLine.match(/^#!\s+\/(\S+)\s*(.*)$/);
  if (!declMatch) {
    throw new Error(
      `Invalid macro file "${filePath}": first non-empty line must be "#! /<command> [description]", got "${declLine}".`
    );
  }

  const command = '/' + declMatch[1];
  let description = declMatch[2].trim();

  // Parse remaining lines for steps.
  const steps: DroneMacroStep[] = [];
  let firstCommentDescription: string | null = null;

  for (let i = declLineIndex + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Skip empty lines.
    if (trimmed.length === 0) continue;

    // Comment lines.
    if (trimmed.startsWith('#')) {
      // Capture the first comment as a fallback description.
      if (firstCommentDescription === null && !description) {
        firstCommentDescription = trimmed.replace(/^#+\s*/, '').trim();
      }
      continue;
    }

    // Slash command steps.
    if (trimmed.startsWith('/')) {
      steps.push({ kind: 'slashCommand', line: trimmed });
      continue;
    }

    // Chat prompt steps (any other non-empty line).
    steps.push({ kind: 'chatPrompt', text: trimmed });
  }

  if (steps.length === 0) {
    throw new Error(
      `Invalid macro file "${filePath}": no steps defined after the declaration line.`
    );
  }

  // Use first comment as fallback description.
  if (!description && firstCommentDescription) {
    description = firstCommentDescription;
  }

  // Scan all step lines for argument placeholders.
  const seenPositions = new Set<number>();
  const argSpec: { position: number; required: boolean }[] = [];
  let hasCatchAll = false;
  let catchAllOptional = false;

  for (const step of steps) {
    const text = step.kind === 'slashCommand' ? step.line : step.text;

    // Scan for positional args ($1, $2, ...)
    let match: RegExpExecArray | null;
    POSITIONAL_PATTERN.lastIndex = 0;
    while ((match = POSITIONAL_PATTERN.exec(text)) !== null) {
      const raw = match[1]; // digit(s)
      const isOptional = match[2] === '?';
      const position = Number.parseInt(raw, 10);
      if (position < 1) {
        throw new Error(
          `Invalid macro file "${filePath}": argument position must be >= 1, got $${position}.`
        );
      }
      if (!seenPositions.has(position)) {
        seenPositions.add(position);
        argSpec.push({ position, required: !isOptional });
      }
    }

    // Scan for catch-all ($$ or $$?)
    CATCHALL_PATTERN.lastIndex = 0;
    const catchAllMatch = CATCHALL_PATTERN.exec(text);
    if (catchAllMatch) {
      hasCatchAll = true;
      if (catchAllMatch[1] === '?') {
        catchAllOptional = true;
      }
    }
  }

  // Sort argSpec by position.
  argSpec.sort((a, b) => a.position - b.position);

  return {
    command,
    description,
    filePath,
    steps,
    argSpec,
    hasCatchAll,
    catchAllOptional,
  };
}

/**
 * Substitute argument placeholders in a line with actual argument values.
 *
 * Rules:
 *   - $N → args[N-1] (error if missing and required)
 *   - $N? → args[N-1] ?? '' (no error if missing)
 *   - $$ → remaining args (after positional placeholders) joined by spaces
 *          (error if no remaining args and required)
 *   - $$? → remaining args joined by spaces, or '' if none remain
 *   - Unknown $X patterns (e.g. $foo) are left as-is
 *
 * Substitution is done in two passes:
 *   1. Replace positional placeholders ($N, $N?) and track which positions
 *      were consumed.
 *   2. Replace $$/$$? with the remaining (unconsumed) args.
 */
export function substituteMacroArgs(
  line: string,
  args: string[],
  macro: DroneMacroDefinition
): string {
  // Track which positional indices have been consumed.
  const consumedIndices = new Set<number>();

  // Pass 1: Replace positional placeholders ($N, $N?).
  let result = line.replace(
    POSITIONAL_PATTERN,
    (_match, raw: string, isOptional: string | undefined) => {
      const optional = isOptional === '?';
      const position = Number.parseInt(raw, 10);
      const index = position - 1;
      consumedIndices.add(index);

      if (index >= args.length) {
        if (optional) return '';
        throw new Error(
          `Macro "${macro.command}" requires argument $${position}, but only ${args.length} argument(s) were provided.`
        );
      }

      return args[index];
    }
  );

  // Pass 2: Replace catch-all ($$ or $$?) with remaining args.
  result = result.replace(
    CATCHALL_PATTERN,
    (_match, isOptional: string | undefined) => {
      const optional = isOptional === '?';
      const remaining = args.filter((_, i) => !consumedIndices.has(i));

      if (remaining.length === 0) {
        if (optional) return '';
        throw new Error(
          `Macro "${macro.command}" requires arguments for $$, but none were provided.`
        );
      }

      return remaining.join(' ');
    }
  );

  return result;
}

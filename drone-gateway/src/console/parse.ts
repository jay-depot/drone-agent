import { tokenize } from './tokenize.js';
import type { ConsoleCommandRegistry } from './registry.js';
import type { ParsedCommand } from './types.js';

/**
 * Parses a console line into a command name, positionals, and flags. Returns
 * null when the first token is not a `swarm.` command, so the caller can fall
 * through to sibling control surfaces.
 *
 * A `--flag` consumes the following token as its value only when the resolved
 * command declares it in `valueFlags` and the next token is not itself a flag;
 * otherwise the flag is boolean `true`.
 */
export function parseCommand(
  line: string,
  registry: ConsoleCommandRegistry
): ParsedCommand | null {
  const tokens = tokenize(line);
  if (tokens.length === 0) return null;

  const name = tokens[0];
  if (!name.startsWith('swarm.')) return null;

  const command = registry.get(name);
  const valueFlags = new Set(command?.valueFlags ?? []);

  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--') && token.length > 2) {
      const flagName = token.slice(2);
      const next = tokens[i + 1];
      if (
        valueFlags.has(flagName) &&
        next !== undefined &&
        !next.startsWith('--')
      ) {
        flags[flagName] = next;
        i++;
      } else {
        flags[flagName] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  return { name, positionals, flags, json: flags.json === true };
}

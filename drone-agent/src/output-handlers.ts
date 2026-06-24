import { stdout as output } from 'node:process';

/**
 * Event types for structured output (NDJSON protocol).
 * These match the event kinds used by conversation.sendUserMessage.
 */
export type OutputEvent =
  | { kind: 'assistantMessage'; content: string }
  | { kind: 'reasoning'; content: string }
  | { kind: 'toolCall'; name: string; input: Record<string, unknown> }
  | { kind: 'toolResult'; name: string; result: string }
  | { kind: 'error'; message: string }
  | { kind: 'return'; result: string; error?: string; subagentId?: string };

/**
 * Builds a plain-text event handler for `sendUserMessage` that mirrors what
 * the TUI does, so `--plain-output` mode (and `chat` invocations) show tool
 * calls and errors as they happen instead of just the final assistant reply.
 */
export function makePlainOutputEventHandler() {
  return (event: {
    kind: string;
    content?: string;
    name?: string;
    message?: string;
  }): void => {
    switch (event.kind) {
      case 'reasoning':
        output.write(`\x1b[90m${event.content}\x1b[0m\n`);
        break;
      case 'toolCall':
        output.write(
          `\x1b[33m⚡ ${event.name}(${JSON.stringify(event.content ?? {})})\x1b[0m\n`
        );
        break;
      case 'toolResult':
        output.write(`\x1b[32m✓ ${event.name}\x1b[0m\n`);
        break;
      case 'error':
        output.write(`\x1b[31m✗ ${event.message}\x1b[0m\n`);
        break;
      case 'assistantMessage':
        // Suppress — the final reply is printed by the caller.
        break;
    }
  };
}

/**
 * Builds a JSON event handler for `sendUserMessage` that collects all events
 * into an array for structured output.
 */
export function makeJsonOutputEventHandler() {
  const events: Array<{
    kind: string;
    content?: string;
    name?: string;
    message?: string;
  }> = [];
  const handler = (event: {
    kind: string;
    content?: string;
    name?: string;
    message?: string;
  }): void => {
    events.push(event);
  };
  return { handler, getEvents: () => events };
}

/**
 * Builds an NDJSON output event handler that writes each event as a
 * JSON line to stdout. Used for `--output-json` mode.
 *
 * Each event is stringified and written on its own line, allowing
 * parent processes to parse structured output line-by-line.
 */
export function makeNdjsonOutputEventHandler() {
  return (event: OutputEvent): void => {
    output.write(JSON.stringify(event) + '\n');
  };
}

/**
 * Write an NDJSON event directly to stdout (for use outside of
 * conversation.sendUserMessage, e.g., subagent.return).
 */
export function writeNdjsonEvent(event: OutputEvent): void {
  output.write(JSON.stringify(event) + '\n');
}
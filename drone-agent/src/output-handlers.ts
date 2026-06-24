import { stdout as output } from 'node:process';

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
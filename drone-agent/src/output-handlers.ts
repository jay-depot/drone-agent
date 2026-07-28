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
  | { kind: 'return'; result: string; error?: string; subagentId?: string }
  | { kind: 'turnComplete' };

/**
 * Builds a plain-text event handler for `sendUserMessage` that mirrors what
 * the TUI does, so `--plain-output` mode (and `chat` invocations) show tool
 * calls and errors as they happen instead of just the final assistant reply.
 *
 * Handles the new batch event kinds (toolCallBatch, toolResultBatch,
 * reasoningComplete, assistantMessageComplete) by silently ignoring the
 * complete markers and flattening batches into individual events.
 */
export function makePlainOutputEventHandler() {
  return (event: {
    kind: string;
    content?: string;
    arguments?: Record<string, unknown>;
    name?: string;
    message?: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    results?: Array<{ name: string; content: string }>;
  }): void => {
    switch (event.kind) {
      case 'reasoning':
        output.write(`\x1b[90m${event.content}\x1b[0m\n`);
        break;
      case 'reasoningComplete':
        // No-op — the reasoning block is already flushed
        break;
      case 'toolCall':
        output.write(
          `\x1b[33m⚡ ${event.name}(${JSON.stringify(event.arguments ?? {})})\x1b[0m\n`
        );
        break;
      case 'toolCallBatch':
        // Flatten: emit individual tool call entries for each one
        if (event.toolCalls) {
          for (const tc of event.toolCalls) {
            output.write(
              `\x1b[33m⚡ ${tc.name}(${JSON.stringify(tc.arguments)})\x1b[0m\n`
            );
          }
        }
        break;
      case 'toolResult':
        output.write(`\x1b[32m✓ ${event.name}\x1b[0m\n`);
        break;
      case 'toolResultBatch':
        // Flatten: emit individual tool result entries for each one
        if (event.results) {
          for (const result of event.results) {
            output.write(`\x1b[32m✓ ${result.name}\x1b[0m\n`);
          }
        }
        break;
      case 'error':
        output.write(`\x1b[31m✗ ${event.message}\x1b[0m\n`);
        break;
      case 'assistantMessage':
        // Suppress — the final reply is printed by the caller.
        break;
      case 'assistantMessageComplete':
        // No-op
        break;
    }
  };
}

/**
 * Write an NDJSON event directly to stdout (for use outside of
 * conversation.sendUserMessage, e.g., subagent.return).
 */
export function writeNdjsonEvent(event: OutputEvent): void {
  output.write(JSON.stringify(event) + '\n');
}

/**
 * Builds an NDJSON output event handler that writes each event as a
 * JSON line to stdout. Used for `--output-json` mode.
 *
 * Each event is stringified and written on its own line, allowing
 * parent processes to parse structured output line-by-line.
 *
 * Handles batch events by flattening them into individual tool call/result
 * entries for backward compatibility with the NDJSON protocol.
 */
export function makeNdjsonOutputEventHandler() {
  return (event: OutputEvent): void => {
    output.write(JSON.stringify(event) + '\n');
  };
}
